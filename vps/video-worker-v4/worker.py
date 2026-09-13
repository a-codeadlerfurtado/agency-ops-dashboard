#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, math, os, re, shutil, subprocess, time, threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

VERSION="4.0.0"
FFMPEG=os.getenv("FFMPEG_BIN","ffmpeg"); FFPROBE=os.getenv("FFPROBE_BIN","ffprobe")
WORK=Path(os.getenv("VIDEO_WORK_DIR","/data/work")); WORK.mkdir(parents=True,exist_ok=True)
POLL=max(5,int(os.getenv("VIDEO_POLL_SECONDS","10")))
MAX_INPUT=int(os.getenv("VIDEO_MAX_INPUT_BYTES",str(2*1024**3))); MAX_JOB=int(os.getenv("VIDEO_MAX_JOB_BYTES",str(8*1024**3)))
DRIVE_DOWNLOAD_BRIDGE_URL=os.getenv("DRIVE_DOWNLOAD_BRIDGE_URL","").strip()
DRIVE_UPLOAD_BRIDGE_URL=os.getenv("DRIVE_UPLOAD_BRIDGE_URL","").strip()
API_SLUG=os.getenv("VIDEO_V4_API_SLUG","agency-ops-video-v4-worker-api")
FONT=os.getenv("VIDEO_FONT_FILE","/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

def secret(name,default=None):
    value=os.getenv(name)
    if value: return value
    fp=os.getenv(name+"_FILE")
    return Path(fp).read_text(encoding="utf-8").strip() if fp else default

def run(cmd,timeout=1800,check=True):
    p=subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
    if check and p.returncode: raise RuntimeError((p.stderr or p.stdout or "command_failed")[-5000:])
    return p

def sha256(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()

def ffprobe(path):
    data=json.loads(run([FFPROBE,"-v","error","-show_format","-show_streams","-of","json",str(path)],60).stdout)
    fmt=data.get("format",{}); streams=data.get("streams",[])
    video=next((x for x in streams if x.get("codec_type")=="video"),None); audio=next((x for x in streams if x.get("codec_type")=="audio"),None)
    if not video: raise ValueError("no_video_stream")
    fr=video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"; a,b=fr.split("/",1); fps=float(a)/float(b) if float(b) else 0
    duration=float(fmt.get("duration") or video.get("duration") or 0)
    if not math.isfinite(duration) or duration<=0: raise ValueError("invalid_duration")
    return {"duration_seconds":round(duration,3),"width":int(video.get("width",0)),"height":int(video.get("height",0)),"fps":round(fps,3),"video_codec":video.get("codec_name"),"audio_codec":audio.get("codec_name") if audio else None,"has_audio":bool(audio),"size_bytes":int(fmt.get("size") or Path(path).stat().st_size)}

def proxy(src,dst):
    run([FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-i",str(src),"-an","-vf","scale='min(540,iw)':-2,fps=8","-c:v","libx264","-preset","veryfast","-crf","30",str(dst)],900)

def detect_scenes(path):
    r=run([FFMPEG,"-nostdin","-hide_banner","-loglevel","info","-i",str(path),"-vf","select='gt(scene,0.25)',showinfo","-an","-f","null","-"],600,False)
    return sorted({round(float(x),3) for x in re.findall(r"pts_time:([0-9.]+)",r.stderr)})

def detect_black(path):
    r=run([FFMPEG,"-nostdin","-hide_banner","-loglevel","info","-i",str(path),"-vf","blackdetect=d=0.30:pix_th=0.10","-an","-f","null","-"],600,False)
    return [{"start":float(a),"end":float(b),"duration":float(c)} for a,b,c in re.findall(r"black_start:([0-9.]+) black_end:([0-9.]+) black_duration:([0-9.]+)",r.stderr)]

def temporal(src,jobdir,index):
    meta=ffprobe(src); px=jobdir/f"proxy-{index}.mp4"; proxy(src,px)
    result={**meta,"cut_timestamps":detect_scenes(px),"black_ranges":detect_black(px),"analysis_version":"video-temporal-v4","model":"ffmpeg-v4"}
    px.unlink(missing_ok=True); return result

def overlap(a,b): return max(0,min(a[1],b[1])-max(a[0],b[0]))
def black_ratio(start,end,ranges):
    d=max(0.01,end-start); return sum(overlap((start,end),(float(x["start"]),float(x["end"]))) for x in ranges)/d

def candidates(inputs,analyses):
    out=[]
    for idx,(item,a) in enumerate(zip(inputs,analyses)):
        dur=float(a["duration_seconds"]); cuts=[0.10]+[float(x)+0.04 for x in a.get("cut_timestamps",[]) if 0<float(x)<dur-0.2]+[dur]
        cuts=sorted(set(round(max(0,min(dur,x)),3) for x in cuts))
        for n in range(len(cuts)-1):
            start,end=cuts[n],cuts[n+1]
            if end-start<0.55: continue
            br=black_ratio(start,end,a.get("black_ranges",[]))
            if br>0.35: continue
            length=end-start; score=100-(abs(min(length,4)-1.8)*10)-(br*90)+(6 if idx==0 else 0)
            out.append({"assetId":str(item.get("asset_id") or item["id"]),"input":idx,"start":start,"end":end,"score":score,"reason":[f"scene_{n}",f"score_{score:.1f}"]})
    if not out:
        for idx,(item,a) in enumerate(zip(inputs,analyses)):
            dur=float(a["duration_seconds"]); out.append({"assetId":str(item.get("asset_id") or item["id"]),"input":idx,"start":0.10,"end":max(0.7,min(dur,3.0)),"score":10,"reason":["fallback"]})
    return sorted(out,key=lambda x:x["score"],reverse=True)

def stage_ranges(strategy,target):
    defaults={"VISUAL_HOOK":(0,target*.10),"PRIMARY_BENEFIT":(target*.10,target*.28),"PROPERTY_TOUR":(target*.28,target*.72),"COMMERCIAL_SAFE":(target*.72,target*.88),"BRANDED_CLOSE":(target*.88,target)}
    for s in strategy.get("stages",[]) if isinstance(strategy,dict) else []:
        role=str(s.get("role") or s.get("name") or s.get("stage") or "").upper()
        if role in defaults:
            try:
                start=float(s.get("from",s.get("start"))); end=float(s.get("to",s.get("end")))
                if end>start: defaults[role]=(start,end)
            except Exception: pass
    return defaults

def field_value(job,*keys):
    pc=job.get("product_context") or {}
    fields=((job.get("client_context") or {}).get("fields") or {})
    for key in keys:
        value=pc.get(key)
        if value not in (None,""): return str(value)
        row=fields.get(key)
        if isinstance(row,dict) and row.get("value") not in (None,""): return str(row["value"])
    return None

def parse_brl(value):
    if not value: return 0
    s=re.sub(r"[^0-9,.-]","",str(value)).replace(".","").replace(",",".")
    try:return float(s)
    except:return 0

def build_timeline(job,inputs,analyses):
    strategy=job.get("edit_strategy") or {}; target=float(strategy.get("target_duration_seconds") or 18); target=max(12,min(30,target))
    ranges=stage_ranges(strategy,target); pool=candidates(inputs,analyses); price=field_value(job,"price","preco","valor")
    style="LUXURY_CINEMATIC" if parse_brl(price)>=2000000 else "PERFORMANCE_AD"
    assets=[{"id":str(i.get("asset_id") or i["id"]),"kind":"video","driveFileId":i["drive_file_id"],"fileName":i.get("file_name"),"duration":a["duration_seconds"],"width":a["width"],"height":a["height"],"metadata":{"analysis":a}} for i,a in zip(inputs,analyses)]
    used={}; shots=[]; global_index=0
    for stage in ["VISUAL_HOOK","PRIMARY_BENEFIT","PROPERTY_TOUR","COMMERCIAL_SAFE"]:
        start,end=ranges[stage]; sd=end-start
        count=2 if stage=="VISUAL_HOOK" else max(1,round(sd/(2.2 if style=="LUXURY_CINEMATIC" else 1.25 if stage=="PROPERTY_TOUR" else 1.55)))
        cursor=start
        for n in range(count):
            duration=(end-start)/count if n<count-1 else end-cursor
            ranked=sorted(pool,key=lambda c:c["score"]-used.get(c["assetId"],0)*9,reverse=True); c=ranked[0]; used[c["assetId"]]=used.get(c["assetId"],0)+1
            available=max(.5,c["end"]-c["start"]); source_span=min(available,max(.65,duration*(1.15 if style!="LUXURY_CINEMATIC" else 1.02)))
            if global_index==0: trans=None
            elif style=="LUXURY_CINEMATIC": trans={"kind":"crossfade" if global_index%3==0 else "match_motion","duration":.22 if global_index%3==0 else .12}
            else:
                kinds=["whip","zoom","foreground_wipe","match_motion","crossfade"]; trans={"kind":kinds[global_index%len(kinds)],"duration":.12 if kinds[global_index%len(kinds)]!="crossfade" else .18}
            effects=[{"kind":"smart_reframe","enabled":True,"provider":"ffmpeg"},{"kind":"color_match","enabled":True,"provider":"ffmpeg","intensity":.7},{"kind":"exposure","enabled":True,"provider":"ffmpeg","intensity":.4},{"kind":"white_balance","enabled":True,"provider":"ffmpeg","intensity":.4}]
            if style!="LUXURY_CINEMATIC" and (stage=="VISUAL_HOOK" or global_index%2==0): effects += [{"kind":"speed_ramp","enabled":True,"provider":"ffmpeg","intensity":.6},{"kind":"motion_blur","enabled":True,"provider":"ffmpeg","intensity":.42}]
            if style=="LUXURY_CINEMATIC": effects.append({"kind":"vignette","enabled":True,"provider":"ffmpeg","intensity":.10})
            shots.append({"id":f"shot-{global_index+1}","type":"video","assetId":c["assetId"],"stage":stage,"start":round(cursor,3),"duration":round(duration,3),"trimIn":round(c["start"],3),"trimOut":round(min(c["end"],c["start"]+source_span),3),"speed":round(source_span/max(.1,duration),3),"fit":"cover","volume":.12,"effects":effects,"transitionIn":trans,"metadata":{"selectionReason":c["reason"]}})
            cursor+=duration; global_index+=1
    cs,ce=ranges["BRANDED_CLOSE"]; hero=pool[0]
    shots.append({"id":f"shot-{global_index+1}","type":"video","assetId":hero["assetId"],"stage":"BRANDED_CLOSE","start":round(cs,3),"duration":round(ce-cs,3),"trimIn":round(hero["start"],3),"trimOut":round(min(hero["end"],hero["start"]+(ce-cs)),3),"speed":1.0,"fit":"cover","volume":.08,"effects":[{"kind":"smart_reframe","enabled":True,"provider":"ffmpeg"},{"kind":"color_match","enabled":True,"provider":"ffmpeg","intensity":.75}],"transitionIn":{"kind":"crossfade","duration":.24}})
    product=str(job.get("product_name") or "").strip(); area=field_value(job,"area","area_m2","metragem"); location=field_value(job,"address","location","localizacao","bairro","city","cidade")
    texts=[]
    def add_text(stage,text,y,size):
        if not text:return
        s,e=ranges[stage]; texts.append({"id":f"text-{stage.lower()}","type":"text","stage":stage,"start":round(s+.12,3),"duration":round(max(.6,e-s-.25),3),"text":text,"fontFamily":"DejaVu Sans","fontSize":size,"fontWeight":700,"color":"#FFFFFF","align":"left","x":108,"y":y,"maxWidth":850,"animationIn":{"preset":"slide_up","duration":.24,"easing":"ease_out"},"animationOut":{"preset":"fade","duration":.18,"easing":"ease_in"},"shadow":{"color":"#000000AA","blur":18,"x":0,"y":6}})
    add_text("VISUAL_HOOK",product or location,330,72); add_text("PRIMARY_BENEFIT",area,470,58); add_text("COMMERCIAL_SAFE",price,560,64); add_text("BRANDED_CLOSE","Agende sua visita",1400,68)
    return {"version":"timeline-v1","jobId":job["id"],"createdAt":datetime.now(timezone.utc).isoformat(),"strategyVersion":job.get("strategy_version") or "dynamic-strategy-v3","directorVersion":"creative-director-v4.1.0","style":style,"canvas":{"width":1080,"height":1920,"fps":30,"aspectRatio":"9:16","background":"#000000"},"safeZone":{"top":240,"right":80,"bottom":320,"left":80},"duration":target,"assets":assets,"tracks":[{"id":"video-main","kind":"video","name":"Main picture","items":shots},{"id":"text-main","kind":"text","name":"Copy / motion graphics","items":texts}],"render":{"container":"mp4","videoCodec":"h264","audioCodec":"aac","videoBitrateMbps":10,"audioBitrateKbps":192,"pixelFormat":"yuv420p"},"metadata":{"clientId":job.get("client_id"),"productId":job.get("product_id"),"contextVersion":job.get("context_version"),"generatedBy":"creative-director-v4","warnings":[]}}

def effect_names(item): return {str(x.get("kind")) for x in item.get("effects",[]) if x.get("enabled",True)}
def render_shot(src,item,analysis,out,render_duration):
    trim_in=float(item["trimIn"]); trim_out=float(item["trimOut"]); span=max(.3,trim_out-trim_in); effects=effect_names(item)
    cmd=[FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-ss",str(trim_in),"-t",str(span),"-i",str(src)]
    no_audio=not analysis.get("has_audio")
    if no_audio: cmd += ["-f","lavfi","-t",str(render_duration),"-i","anullsrc=r=48000:cl=stereo"]
    base="scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,eq=contrast=1.045:saturation=1.07:brightness=0.008:gamma=0.99"
    if "vignette" in effects: base += ",vignette=PI/5"
    if "speed_ramp" in effects and span>=.9:
        a=span*.28; b=span*.72
        graph=f"[0:v]split=3[v0][v1][v2];[v0]trim=start=0:end={a:.3f},setpts=(PTS-STARTPTS)/1.28[va];[v1]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/0.92[vb];[v2]trim=start={b:.3f}:end={span:.3f},setpts=(PTS-STARTPTS)/1.22[vc];[va][vb][vc]concat=n=3:v=1:a=0,{base}"
    else:
        speed=max(.75,min(1.35,float(item.get("speed") or 1))); graph=f"[0:v]setpts=(PTS-STARTPTS)/{speed:.4f},{base}"
    if "motion_blur" in effects: graph += ",tmix=frames=3:weights='1 2 1'"
    graph += f",fps=30,tpad=stop_mode=clone:stop_duration=1,trim=duration={render_duration:.3f},setpts=PTS-STARTPTS[vout];"
    if no_audio: graph += f"[1:a]atrim=duration={render_duration:.3f},asetpts=PTS-STARTPTS[aout]"
    else: graph += f"[0:a]atrim=duration={render_duration:.3f},asetpts=PTS-STARTPTS,volume=0.10,apad,atrim=duration={render_duration:.3f}[aout]"
    cmd += ["-filter_complex",graph,"-map","[vout]","-map","[aout]","-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-movflags","+faststart",str(out)]
    run(cmd,1200)

def transition_name(kind): return {"crossfade":"fade","whip":"slideleft","zoom":"zoomin","foreground_wipe":"smoothleft","mask_wipe":"circleopen","match_motion":"smoothright"}.get(kind,"fade")
def combine_segments(paths,items,durations,out):
    cmd=[FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y"]
    for p in paths: cmd += ["-i",str(p)]
    filters=[]
    for i in range(len(paths)):
        filters += [f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]",f"[{i}:a]aresample=48000,asetpts=PTS-STARTPTS[a{i}]"]
    cv="v0"; ca="a0"; cumulative=durations[0]
    for i in range(1,len(paths)):
        trans=items[i].get("transitionIn") or {}; d=max(.06,min(.35,float(trans.get("duration") or .08))); off=max(.01,cumulative-d)
        nv=f"vx{i}"; na=f"ax{i}"; name=transition_name(str(trans.get("kind") or "crossfade"))
        filters.append(f"[{cv}][v{i}]xfade=transition={name}:duration={d:.3f}:offset={off:.3f}[{nv}]")
        filters.append(f"[{ca}][a{i}]acrossfade=d={d:.3f}:c1=tri:c2=tri[{na}]")
        cv,ca=nv,na; cumulative += durations[i]-d
    filters += [f"[{cv}]format=yuv420p[vout]",f"[{ca}]alimiter=limit=0.92[aout]"]
    cmd += ["-filter_complex",";".join(filters),"-map","[vout]","-map","[aout]","-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-b:a","160k","-movflags","+faststart",str(out)]
    run(cmd,1800); return cumulative

def esc_text(value): return str(value).replace("\\","\\\\").replace(":","\\:").replace("'","\\'").replace("%","\\%").replace("[","\\[").replace("]","\\]")
def decorate(base,timeline,out):
    texts=next((t.get("items",[]) for t in timeline.get("tracks",[]) if t.get("kind")=="text"),[])
    videos=next((t.get("items",[]) for t in timeline.get("tracks",[]) if t.get("kind")=="video"),[])
    filters=["[0:v]format=yuv420p[v0]"]; current="v0"
    for i,t in enumerate(texts):
        text=esc_text(t.get("text",""))[:150]; start=float(t.get("start",0)); end=start+float(t.get("duration",1)); y=float(t.get("y",330)); x=float(t.get("x",108)); size=max(28,min(86,int(t.get("fontSize",58)))); nxt=f"vt{i}"
        yexpr=f"{y:.0f}+40*if(lt(t\\,{start+.24:.3f})\\,1-(t-{start:.3f})/.24\\,0)"
        alpha=f"if(lt(t\\,{start+.18:.3f})\\,(t-{start:.3f})/.18\\,if(gt(t\\,{end-.18:.3f})\\,({end:.3f}-t)/.18\\,1))"
        box="box=1:boxcolor=black@0.28:boxborderw=14:" if str(t.get("stage"))=="COMMERCIAL_SAFE" else ""
        filters.append(f"[{current}]drawtext=fontfile='{FONT}':text='{text}':fontcolor=white:fontsize={size}:x={x:.0f}:y='{yexpr}':alpha='{alpha}':{box}shadowcolor=black@0.75:shadowx=3:shadowy=4:enable='between(t,{start:.3f},{end:.3f})'[{nxt}]")
        current=nxt
    filters.append(f"[{current}]format=yuv420p[vout]")
    transition_times=[]
    for v in videos[1:]:
        tr=v.get("transitionIn") or {}
        if float(tr.get("duration") or 0)>0: transition_times.append(float(v.get("start") or 0))
    audio_labels=[]
    filters.append("[0:a]volume=0.78[abase]")
    for i,t in enumerate(transition_times):
        ms=max(0,int((t-.06)*1000)); label=f"sfx{i}"
        filters.append(f"anoisesrc=color=pink:amplitude=0.055:duration=0.18,aformat=channel_layouts=stereo,highpass=f=650,lowpass=f=5200,afade=t=in:st=0:d=0.035,afade=t=out:st=0.07:d=0.11,adelay={ms}|{ms}[{label}]")
        audio_labels.append(label)
    if audio_labels:
        filters.append("[abase]"+"".join(f"[{x}]" for x in audio_labels)+f"amix=inputs={1+len(audio_labels)}:duration=first:normalize=0,alimiter=limit=0.9[aout]")
    else: filters.append("[abase]anull[aout]")
    run([FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-i",str(base),"-filter_complex",";".join(filters),"-map","[vout]","-map","[aout]","-c:v","libx264","-preset","veryfast","-crf","20","-maxrate","8M","-bufsize","16M","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-movflags","+faststart","-shortest",str(out)],1800)

def render_timeline(paths,analyses,timeline,jobdir,out):
    items=next(t["items"] for t in timeline["tracks"] if t["kind"]=="video"); asset_to_input={str(a["id"]):idx for idx,a in enumerate(timeline["assets"])}
    segments=[]; durations=[]
    for idx,item in enumerate(items):
        trans=item.get("transitionIn") or {}; d=max(.06,min(.35,float(trans.get("duration") or .08))) if idx else 0
        rd=float(item["duration"])+d; seg=jobdir/f"segment-{idx:02d}.mp4"; input_idx=asset_to_input[item["assetId"]]
        render_shot(paths[input_idx],item,analyses[input_idx],seg,rd); segments.append(seg); durations.append(rd)
    base=jobdir/"base-v4.mp4"; effective=combine_segments(segments,items,durations,base); decorate(base,timeline,out); return {"segments":len(segments),"effective_duration":round(effective,3),"transition_count":max(0,len(segments)-1)}

def qa(path,target):
    meta=ffprobe(path); black=detect_black(path)
    checks={"file_exists":Path(path).exists(),"playable":True,"mp4":Path(path).suffix.lower()==".mp4","video_codec_h264":meta["video_codec"]=="h264","audio_codec_aac":meta["audio_codec"]=="aac","resolution_1080x1920":meta["width"]==1080 and meta["height"]==1920,"fps_approved":29<=meta["fps"]<=31,"duration_valid":max(8,target-2.5)<=meta["duration_seconds"]<=target+3,"no_problematic_black":not any(x["duration"]>=.9 for x in black)}
    return {**meta,"checks":checks,"black_ranges":black,"file_exists":True,"playable":True,"pass":all(checks.values()),"qa_version":"video-qa-v4"}

def http_json(url,method="GET",headers=None,body=None):
    data=None if body is None else json.dumps(body).encode()
    try:
        with urlopen(Request(url,data=data,headers={"content-type":"application/json",**(headers or {})},method=method),timeout=180) as r: return json.loads(r.read())
    except HTTPError as e: raise RuntimeError(f"http_{e.code}:{e.read(1500).decode(errors='replace')}")

def drive_download(file_id,dst):
    token=secret("VIDEO_EDIT_WORKER_TOKEN");
    if not DRIVE_DOWNLOAD_BRIDGE_URL or not token: raise RuntimeError("drive_download_bridge_not_configured")
    req=Request(DRIVE_DOWNLOAD_BRIDGE_URL,data=json.dumps({"drive_file_id":str(file_id)}).encode(),headers={"content-type":"application/json","x-video-worker-token":token},method="POST")
    total=0
    with urlopen(req,timeout=900) as r,Path(dst).open("wb") as f:
        while True:
            chunk=r.read(1024*1024)
            if not chunk: break
            total+=len(chunk)
            if total>MAX_INPUT: raise ValueError("input_too_large")
            f.write(chunk)
    if total<=0: raise ValueError("drive_input_empty")

def drive_upload(path,name,parent,job_id,variant):
    token=secret("VIDEO_EDIT_WORKER_TOKEN")
    if not DRIVE_UPLOAD_BRIDGE_URL or not token: raise RuntimeError("drive_upload_bridge_not_configured")
    boundary="video-"+hashlib.sha1(os.urandom(32)).hexdigest(); fields={"folder_id":str(parent),"file_name":str(name),"job_id":str(job_id),"variant":str(variant),"renderer_version":VERSION}; parts=[]
    for key,value in fields.items(): parts.append(("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+key+"\"\r\n\r\n"+value+"\r\n").encode())
    media=Path(path).read_bytes(); parts.append(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"data\"; filename=\""+name+"\"\r\nContent-Type: video/mp4\r\n\r\n").encode()+media+b"\r\n"); parts.append(("--"+boundary+"--\r\n").encode())
    req=Request(DRIVE_UPLOAD_BRIDGE_URL,data=b"".join(parts),headers={"x-video-worker-token":token,"Content-Type":"multipart/form-data; boundary="+boundary},method="POST")
    try:
        with urlopen(req,timeout=1200) as r: result=json.loads(r.read())
    except HTTPError as e: raise RuntimeError(f"drive_upload_bridge_http_{e.code}:{e.read(1500).decode(errors='replace')}")
    file_id=result.get("drive_file_id")
    if not file_id: raise RuntimeError("drive_upload_bridge_missing_id")
    return {"id":file_id,"webViewLink":result.get("drive_url") or f"https://drive.google.com/file/d/{file_id}/view"}

def output_name(job,variant):
    clean=lambda x:re.sub(r"[^A-Za-z0-9_-]+","_",str(x or "TESTE")).strip("_")[:45]
    client=((job.get("client_context") or {}).get("client") or {}).get("name")
    return f"{clean(client)}_{clean(job.get('product_name'))}_{clean(variant)}_{datetime.now(timezone.utc):%Y%m%d}_{str(job['id'])[:8]}.mp4"

def daemon():
    base=os.environ["SUPABASE_URL"].rstrip("/")+"/functions/v1/"+API_SLUG; worker=os.getenv("VIDEO_WORKER_ID","leonardo-video-worker-v4-shadow")
    token=secret("VIDEO_EDIT_WORKER_TOKEN") or (_ for _ in ()).throw(RuntimeError("worker_token_missing")); headers={"x-video-worker-token":token}
    heartbeat_seconds=max(8,int(os.getenv("VIDEO_HEARTBEAT_SECONDS","20"))); last_ping=0.0
    def call(action,payload=None): return http_json(base,"POST",headers,{"action":action,"worker_id":worker,**(payload or {})})
    def ping(state="IDLE",job=None,force=False):
        nonlocal last_ping
        if not force and time.time()-last_ping<45:return
        call("worker_ping",{"worker_version":VERSION,"state":state,"current_job_id":job,"metadata":{"renderer":"ffmpeg-v4","mode":"shadow"}}); last_ping=time.time()
    while True:
        try:
            ping(); claim=call("claim"); rj=claim.get("render_job")
            if not rj: time.sleep(POLL); continue
            rid=str(rj["id"]); source=claim.get("source_job") or {}; inputs=claim.get("inputs") or []; jobdir=WORK/rid; jobdir.mkdir(parents=True,exist_ok=True); stop=threading.Event(); ping("WORKING",source.get("id"),True)
            def hb():
                while not stop.wait(heartbeat_seconds):
                    try: call("heartbeat",{"render_job_id":rid,"stage":"WORKING"}); ping("WORKING",source.get("id"),True)
                    except Exception as e: print(json.dumps({"level":"warning","render_job_id":rid,"heartbeat_error":str(e)}),flush=True)
            th=threading.Thread(target=hb,daemon=True); th.start()
            try:
                call("progress",{"render_job_id":rid,"progress_pct":5,"stage":"DOWNLOADING_INPUTS","status":"CLAIMED"}); paths=[]; total=0
                for idx,item in enumerate(inputs):
                    p=jobdir/(str(idx)+"-"+re.sub(r"[^A-Za-z0-9._-]","_",item.get("file_name") or "input.mp4")); drive_download(item["drive_file_id"],p); total+=p.stat().st_size
                    if total>MAX_JOB: raise ValueError("job_too_large")
                    paths.append(p); call("progress",{"render_job_id":rid,"progress_pct":min(25,8+int((idx+1)/max(1,len(inputs))*17)),"stage":f"DOWNLOADED_{idx+1}","status":"CLAIMED"})
                analyses=[]
                for idx,p in enumerate(paths): analyses.append(temporal(p,jobdir,idx)); call("progress",{"render_job_id":rid,"progress_pct":min(42,28+int((idx+1)/max(1,len(paths))*14)),"stage":f"ANALYZED_{idx+1}","status":"CLAIMED"})
                timeline=build_timeline(source,inputs,analyses); canonical=json.dumps(timeline,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode(); timeline_hash=hashlib.sha256(canonical).hexdigest()
                call("save_timeline",{"render_job_id":rid,"timeline":timeline,"timeline_hash":timeline_hash,"director_version":timeline["directorVersion"],"metadata":{"input_count":len(inputs),"analysis_version":"video-temporal-v4"}})
                out=jobdir/output_name(source,rj.get("variant") or "v4_shadow"); call("progress",{"render_job_id":rid,"progress_pct":48,"stage":"RENDERING_TIMELINE","status":"RENDERING"}); meta=render_timeline(paths,analyses,timeline,jobdir,out)
                call("progress",{"render_job_id":rid,"progress_pct":84,"stage":"RUNNING_QA","status":"QA"}); report=qa(out,float(timeline["duration"]));
                if not report["pass"]: raise ValueError("qa_failed:"+json.dumps(report["checks"]))
                folder=source.get("output_drive_folder_id") or source.get("output_drive_root_id");
                if not folder: raise ValueError("output_drive_folder_missing")
                call("progress",{"render_job_id":rid,"progress_pct":91,"stage":"UPLOADING_DRIVE","status":"UPLOADING"}); up=drive_upload(out,out.name,folder,rid,rj.get("variant") or "v4_shadow")
                result={"qa_status":"PASS","qa_json":report,"drive_file_id":up["id"],"drive_url":up.get("webViewLink"),"file_name":out.name,"duration_seconds":report["duration_seconds"],"content_hash":sha256(out),"size_bytes":out.stat().st_size,"video_codec":report["video_codec"],"audio_codec":report["audio_codec"],"width":report["width"],"height":report["height"],"fps":report["fps"],"render_metadata":{"timeline_hash":timeline_hash,"director_version":timeline["directorVersion"],"style":timeline["style"],**meta}}
                call("complete",{"render_job_id":rid,"renderer_version":VERSION,"render_metadata":{"timeline_hash":timeline_hash,"style":timeline["style"]},"output":result}); print(json.dumps({"event":"v4_completed","render_job_id":rid,"drive_url":up.get("webViewLink"),"qa":report["checks"]},ensure_ascii=False),flush=True)
            except Exception as e:
                print(json.dumps({"event":"v4_failed","render_job_id":rid,"error":str(e)},ensure_ascii=False),flush=True)
                try: call("fail",{"render_job_id":rid,"error":str(e)[:1200]})
                except Exception as ee: print(json.dumps({"event":"v4_fail_report_error","error":str(ee)}),flush=True)
            finally:
                stop.set(); th.join(timeout=2); shutil.rmtree(jobdir,ignore_errors=True); ping("IDLE",None,True)
        except Exception as e:
            print(json.dumps({"level":"error","error":str(e),"at":time.time()}),flush=True); time.sleep(POLL)

if __name__=="__main__": daemon()
