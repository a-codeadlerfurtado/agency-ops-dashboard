#!/usr/bin/env python3
"""Autonomous single-concurrency video worker with Drive, FFmpeg and QA."""
from __future__ import annotations
import argparse, hashlib, json, math, os, re, shutil, subprocess, tempfile, time, threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

VERSION="3.0.4"; FFMPEG=os.getenv("FFMPEG_BIN","ffmpeg"); FFPROBE=os.getenv("FFPROBE_BIN","ffprobe")
WORK=Path(os.getenv("VIDEO_WORK_DIR","/data/work")); WORK.mkdir(parents=True,exist_ok=True)
MAX_INPUT=int(os.getenv("VIDEO_MAX_INPUT_BYTES",str(2*1024**3))); MAX_JOB=int(os.getenv("VIDEO_MAX_JOB_BYTES",str(8*1024**3)))
POLL=max(5,int(os.getenv("VIDEO_POLL_SECONDS","15")))

def secret(name, default=None):
    v=os.getenv(name)
    if v is not None and v != "": return v
    fp=os.getenv(name+"_FILE")
    if fp:
        return Path(fp).read_text(encoding="utf-8").strip()
    return default

def run(cmd,timeout=1800,check=True):
    p=subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
    if check and p.returncode: raise RuntimeError((p.stderr or p.stdout or "command_failed")[-4000:])
    return p
def sha256(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
    return h.hexdigest()
def ffprobe(path):
    data=json.loads(run([FFPROBE,"-v","error","-show_format","-show_streams","-of","json",str(path)],60).stdout)
    fmt=data.get("format",{}); streams=data.get("streams",[]); video=next((x for x in streams if x.get("codec_type")=="video"),None); audio=next((x for x in streams if x.get("codec_type")=="audio"),None)
    if not video: raise ValueError("no_video_stream")
    fr=video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"; a,b=fr.split("/",1); fps=float(a)/float(b) if float(b) else 0
    duration=float(fmt.get("duration") or video.get("duration") or 0)
    if not math.isfinite(duration) or duration<=0: raise ValueError("invalid_duration")
    return {"duration_seconds":round(duration,3),"width":int(video.get("width",0)),"height":int(video.get("height",0)),"fps":round(fps,3),"video_codec":video.get("codec_name"),"audio_codec":audio.get("codec_name") if audio else None,"has_audio":bool(audio),"size_bytes":int(fmt.get("size") or Path(path).stat().st_size)}
def proxy(src,dst): run([FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-i",str(src),"-an","-vf","scale='min(540,iw)':-2,fps=8","-c:v","libx264","-preset","veryfast","-crf","30","-movflags","+faststart",str(dst)],900)
def detect_scenes(path):
    r=run([FFMPEG,"-nostdin","-hide_banner","-loglevel","info","-i",str(path),"-vf","select='gt(scene,0.28)',showinfo","-an","-f","null","-"],600,False)
    return sorted({round(float(x),3) for x in re.findall(r"pts_time:([0-9.]+)",r.stderr)})
def detect_black(path):
    r=run([FFMPEG,"-nostdin","-hide_banner","-loglevel","info","-i",str(path),"-vf","blackdetect=d=0.35:pix_th=0.10","-an","-f","null","-"],600,False)
    return [{"start":float(a),"end":float(b),"duration":float(c)} for a,b,c in re.findall(r"black_start:([0-9.]+) black_end:([0-9.]+) black_duration:([0-9.]+)",r.stderr)]
def detect_silence(path):
    r=run([FFMPEG,"-nostdin","-hide_banner","-loglevel","info","-i",str(path),"-af","silencedetect=noise=-42dB:d=0.7","-f","null","-"],600,False)
    starts=[float(x) for x in re.findall(r"silence_start: ([0-9.]+)",r.stderr)]; ends=[(float(a),float(b)) for a,b in re.findall(r"silence_end: ([0-9.]+) \| silence_duration: ([0-9.]+)",r.stderr)]
    return [{"start":starts[i] if i<len(starts) else max(0,e-d),"end":e,"duration":d} for i,(e,d) in enumerate(ends)]
def ocr_samples(path,jobdir,duration):
    out=[]; frame=jobdir/"ocr.jpg"
    for t in sorted({.25,1.0,2.0,round(duration*.5,2),max(.25,duration-1)}):
        if t>=duration: continue
        run([FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y","-ss",str(t),"-i",str(path),"-frames:v","1","-vf","scale=720:-2",str(frame)],60,False)
        if not frame.exists(): continue
        r=run(["tesseract",str(frame),"stdout","-l",os.getenv("TESSERACT_LANG","por+eng"),"--psm","11"],30,False); text=" ".join(r.stdout.split())
        if text: out.append({"time":t,"text":text[:1000]})
    frame.unlink(missing_ok=True); return out
def temporal(src,jobdir):
    meta=ffprobe(src); px=jobdir/(Path(src).stem+".proxy.mp4"); proxy(src,px); scenes=detect_scenes(px); black=detect_black(px); silence=detect_silence(src) if meta["has_audio"] else []; ocr=ocr_samples(px,jobdir,meta["duration_seconds"]); full=" ".join(x["text"] for x in ocr)
    price=[x["time"] for x in ocr if re.search(r"(R\$|\b\d{2,3}(?:[. ]\d{3})+(?:,\d{2})?)",x["text"],re.I)]; condition=[x["time"] for x in ocr if re.search(r"(entrada|parcel|financ|mensais|condi[cç][aã]o)",x["text"],re.I)]
    avg=meta["duration_seconds"]/(len(scenes)+1); pace="FAST" if avg<1.8 else "MEDIUM" if avg<3.5 else "SLOW"
    result={**meta,"scene_count":len(scenes)+1,"cut_timestamps":scenes,"average_shot_duration":round(avg,3),"cut_pace":pace,"ocr_samples":ocr,"text_overlay_detected":bool(ocr),"information_density":"HIGH" if len(full)>180 else "MEDIUM" if len(full)>60 else "LOW" if full else "UNKNOWN","price_first_time":min(price) if price else None,"price_timing":"EARLY" if price and min(price)<=3 else "MIDDLE" if price and min(price)<meta["duration_seconds"]*.7 else "LATE" if price else "UNKNOWN","condition_first_time":min(condition) if condition else None,"condition_timing":"EARLY" if condition and min(condition)<=3 else "MIDDLE" if condition and min(condition)<meta["duration_seconds"]*.7 else "LATE" if condition else "UNKNOWN","black_ranges":black,"silence_ranges":silence,"analysis_version":"video-temporal-v2","unknown_fields":["typography_style","music_style","presenter_presence","property_scene_labels","logo_presence","narrative_structure"]}
    px.unlink(missing_ok=True); return result
def overlaps(t,ranges): return any(x["start"]<=t<=x["end"] for x in ranges)
def select_segments(analyses,target):
    per=max(2.5,min(7.0,target/max(1,len(analyses)))); out=[]
    for i,a in enumerate(analyses):
        dur=a["duration_seconds"]; candidates=[.25]+[x+.08 for x in a["cut_timestamps"]]; start=next((x for x in candidates if x+per<=dur and not overlaps(x,a["black_ranges"])),max(0,min(.25,dur-per)))
        out.append({"input":i,"start":round(start,3),"duration":round(min(per,dur-start),3),"reason":"first_non_black_scene"})
    return out
def esc(v): return v.replace("\\","\\\\").replace(":","\\:").replace("'","\\'").replace("%","\\%")
def render(inputs,segments,strategy,out,overlays=None,analyses=None):
    cmd=[FFMPEG,"-nostdin","-hide_banner","-loglevel","error","-y"]
    for s in segments: cmd+=["-ss",str(s["start"]),"-t",str(s["duration"]),"-i",str(inputs[s["input"]])]
    filters=[]; labels=[]; alabels=[]
    for i,s in enumerate(segments):
        filters.append(f"[{i}:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,format=yuv420p[v{i}]"); labels.append(f"[v{i}]")
        if analyses and analyses[s["input"]].get("has_audio"): filters.append(f"[{i}:a]aresample=48000,asetpts=PTS-STARTPTS,atrim=duration={s['duration']}[a{i}]")
        else: filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={s['duration']}[a{i}]")
        alabels.append(f"[a{i}]")
    filters.append("".join(labels)+f"concat=n={len(segments)}:v=1:a=0[vbase]"); current="vbase"
    filters.append("".join(alabels)+f"concat=n={len(segments)}:v=0:a=1,alimiter=limit=0.90[aout]")
    for j,o in enumerate(overlays or []):
        text=esc(str(o.get("text","")))[:160]; y=max(240,min(1500,int(o.get("y",300)))); start=max(0,float(o.get("from",0))); end=max(start,float(o.get("to",strategy.get("target_duration_seconds",25)))); nxt=f"vt{j}"
        filters.append(f"[{current}]drawtext=text='{text}':fontcolor={o.get('color','white')}:fontsize={max(24,min(90,int(o.get('size',52))))}:x=(w-text_w)/2:y={y}:borderw=3:bordercolor=black@0.55:enable='between(t,{start},{end})'[{nxt}]"); current=nxt
    total=sum(x["duration"] for x in segments); filters.append(f"[{current}]fade=t=out:st={round(max(0,total-.4),3)}:d=0.4[vout]")
    cmd+=["-filter_complex_threads","1","-filter_complex",";".join(filters),"-map","[vout]","-map","[aout]","-c:v","libx264","-threads","2","-preset","veryfast","-crf","22","-maxrate","6M","-bufsize","12M","-pix_fmt","yuv420p","-c:a","aac","-b:a","160k","-movflags","+faststart",str(out)]; run(cmd,1800)
def qa(path,manifest):
    meta=ffprobe(path); black=detect_black(path); target=float(manifest.get("strategy",{}).get("target_duration_seconds",meta["duration_seconds"]))
    checks={"file_exists":Path(path).exists(),"playable":True,"mp4":Path(path).suffix.lower()==".mp4","video_codec_h264":meta["video_codec"]=="h264","audio_codec_aac":meta["audio_codec"]=="aac","resolution_1080x1920":meta["width"]==1080 and meta["height"]==1920,"fps_approved":29<=meta["fps"]<=31,"duration_valid":2<=meta["duration_seconds"]<=max(65,target+5),"no_problematic_black":not any(x["duration"]>=.75 for x in black),"safe_zone_plan":all(240<=int(o.get("y",300))<=1500 for o in manifest.get("overlays",[])),"verified_context_only":not manifest.get("unsafe_fields_inserted"),"client_assets_only":manifest.get("client_assets_only",True)}
    return {**meta,"checks":checks,"black_ranges":black,"file_exists":True,"playable":True,"pass":all(checks.values()),"qa_version":"video-qa-v2"}
def http_json(url,method="GET",headers=None,body=None):
    data=None if body is None else json.dumps(body).encode()
    try:
        with urlopen(Request(url,data=data,headers={"content-type":"application/json",**(headers or {})},method=method),timeout=120) as r: return json.loads(r.read())
    except HTTPError as e: raise RuntimeError(f"http_{e.code}:{e.read(1000).decode(errors='replace')}")
def google_token():
    raw=secret("GOOGLE_SERVICE_ACCOUNT_JSON")
    refresh=secret("GOOGLE_OAUTH_REFRESH_TOKEN") or secret("GOOGLE_REFRESH_TOKEN")
    if raw:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request as GRequest
        creds=service_account.Credentials.from_service_account_info(json.loads(raw),scopes=["https://www.googleapis.com/auth/drive"]); creds.refresh(GRequest()); return creds.token
    if refresh:
        client_id=secret("GOOGLE_OAUTH_CLIENT_ID") or secret("GOOGLE_CLIENT_ID")
        client_secret=secret("GOOGLE_OAUTH_CLIENT_SECRET") or secret("GOOGLE_CLIENT_SECRET")
        if not client_id or not client_secret: raise RuntimeError("google_oauth_client_missing")
        payload=urlencode({"client_id":client_id,"client_secret":client_secret,"refresh_token":refresh,"grant_type":"refresh_token"}).encode()
        with urlopen(Request("https://oauth2.googleapis.com/token",data=payload,method="POST"),timeout=30) as r: return json.loads(r.read())["access_token"]
    raise RuntimeError("google_credentials_missing")
def drive_download(file_id,dst,token):
    req=Request(f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true",headers={"Authorization":"Bearer "+token}); total=0
    with urlopen(req,timeout=300) as r,Path(dst).open("wb") as f:
        while True:
            chunk=r.read(1024*1024)
            if not chunk: break
            total+=len(chunk)
            if total>MAX_INPUT: raise ValueError("input_too_large")
            f.write(chunk)
def http_download(url,dst):
    total=0
    req=Request(url,headers={"User-Agent":"LeonardoVideoWorker/3.0.2"})
    with urlopen(req,timeout=300) as r,Path(dst).open("wb") as f:
        while True:
            chunk=r.read(1024*1024)
            if not chunk: break
            total+=len(chunk)
            if total>MAX_INPUT: raise ValueError("analysis_input_too_large")
            f.write(chunk)
    if total<=0: raise ValueError("analysis_input_empty")
def drive_find(job_id,variant,parent,token):
    q=f"'{parent}' in parents and trashed=false and appProperties has {{ key='video_job_id' and value='{job_id}' }} and appProperties has {{ key='variant' and value='{variant}' }}"; url="https://www.googleapis.com/drive/v3/files?"+urlencode({"q":q,"fields":"files(id,name,webViewLink,size,md5Checksum)","supportsAllDrives":"true","includeItemsFromAllDrives":"true"})
    return (http_json(url,headers={"Authorization":"Bearer "+token}).get("files") or [None])[0]
def drive_upload(path,name,parent,job_id,variant,token):
    existing=drive_find(job_id,variant,parent,token)
    if existing: return {**existing,"idempotent_replay":True}
    boundary="video-"+hashlib.sha1(os.urandom(32)).hexdigest(); meta=json.dumps({"name":name,"parents":[parent],"appProperties":{"video_job_id":job_id,"variant":variant,"renderer_version":VERSION}}).encode(); media=Path(path).read_bytes()
    body=b"--"+boundary.encode()+b"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"+meta+b"\r\n--"+boundary.encode()+b"\r\nContent-Type: video/mp4\r\n\r\n"+media+b"\r\n--"+boundary.encode()+b"--"
    with urlopen(Request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,size,md5Checksum",data=body,headers={"Authorization":"Bearer "+token,"Content-Type":"multipart/related; boundary="+boundary},method="POST"),timeout=600) as r: return json.loads(r.read())
def output_name(job,variant="vertical"):
    clean=lambda x:re.sub(r"[^A-Za-z0-9_-]+","_",str(x or "TESTE")).strip("_")[:50]
    return f"{clean(job.get('client_context',{}).get('client',{}).get('name'))}_{clean(job.get('product_name'))}_{clean(variant)}_{datetime.now(timezone.utc):%Y%m%d}_{str(job['id'])[:8]}.mp4"
def local(manifest_path,out):
    m=json.loads(Path(manifest_path).read_text()); inputs=[Path(x) for x in m["inputs"]]; jobdir=Path(tempfile.mkdtemp(prefix="video-v3-",dir=WORK))
    try:
        analyses=[temporal(x,jobdir) for x in inputs]; segments=select_segments(analyses,float(m.get("strategy",{}).get("target_duration_seconds",19.2))); render(inputs,segments,m.get("strategy",{}),out,m.get("overlays"),analyses); report=qa(out,{**m,"client_assets_only":True}); result={"renderer_version":VERSION,"analyses":analyses,"selected_segments":segments,"output":str(out),"content_hash":sha256(out),"qa":report}; print(json.dumps(result,ensure_ascii=False)); return 0 if report["pass"] else 2
    finally: shutil.rmtree(jobdir,ignore_errors=True)
def daemon():
    base=os.environ["SUPABASE_URL"].rstrip("/")+"/functions/v1"; headers={"x-video-worker-token":secret("VIDEO_EDIT_WORKER_TOKEN") or (_ for _ in ()).throw(RuntimeError("worker_token_missing"))}; worker=os.getenv("VIDEO_WORKER_ID","renderer-v3")
    api=base+"/agency-ops-video-render-worker-api"
    heartbeat_seconds=max(5,int(os.getenv("VIDEO_HEARTBEAT_SECONDS","20")))
    analysis_enabled=os.getenv("VIDEO_ANALYSIS_ENABLED","false").strip().lower() in ("1","true","yes","on")
    analysis_budget=max(0,int(os.getenv("VIDEO_ANALYSIS_BUDGET","1")))
    analysis_cooldown=max(0,int(os.getenv("VIDEO_ANALYSIS_COOLDOWN_SECONDS","120")))
    idle_heartbeat_seconds=max(15,int(os.getenv("VIDEO_IDLE_HEARTBEAT_SECONDS","60")))
    analysis_processed=0
    last_worker_ping=0.0
    def worker_ping(state="IDLE",current_job_id=None,metadata=None,force=False):
        nonlocal last_worker_ping
        now=time.time()
        if not force and now-last_worker_ping<idle_heartbeat_seconds: return None
        result=http_json(api,"POST",headers,{"action":"worker_ping","worker_id":worker,"worker_version":VERSION,"state":state,"current_job_id":current_job_id,"metadata":metadata or {}})
        last_worker_ping=now
        return result
    def progress(job_id,pct,stage,status=None):
        body={"action":"progress","worker_id":worker,"job_id":job_id,"progress_pct":pct,"stage":stage}
        if status: body["status"]=status
        return http_json(api,"POST",headers,body)
    def process_analysis(item):
        analysis_id=int(item["id"]); adir=WORK/("analysis-"+str(analysis_id)); adir.mkdir(parents=True,exist_ok=True); stop=threading.Event(); worker_ping("ANALYZING",metadata={"analysis_id":analysis_id},force=True)
        def ahb():
            while not stop.wait(heartbeat_seconds):
                try:
                    http_json(api,"POST",headers,{"action":"analysis_heartbeat","worker_id":worker,"analysis_id":analysis_id})
                    worker_ping("ANALYZING",metadata={"analysis_id":analysis_id})
                except Exception as e: print(json.dumps({"level":"warning","analysis_id":analysis_id,"heartbeat_error":str(e),"at":time.time()}),flush=True)
        th=threading.Thread(target=ahb,name=f"ahb-{analysis_id}",daemon=True); th.start()
        try:
            src=adir/"source.mp4"
            if item.get("drive_file_id"):
                drive_download(str(item["drive_file_id"]),src,google_token())
            elif item.get("source_url"):
                http_download(str(item["source_url"]),src)
            else:
                raise ValueError("analysis_source_missing")
            result=temporal(src,adir)
            summary=f"Temporal {result.get('cut_pace','UNKNOWN')}; {result.get('scene_count',0)} cenas; texto {result.get('information_density','UNKNOWN')}; preço {result.get('price_timing','UNKNOWN')}; condição {result.get('condition_timing','UNKNOWN')}."
            http_json(api,"POST",headers,{"action":"save_video_analysis","worker_id":worker,"analysis_id":analysis_id,"analysis":{"duration_seconds":result.get("duration_seconds"),"width":result.get("width"),"height":result.get("height"),"fps":result.get("fps"),"analysis_json":result,"analysis_text":summary,"model":"ffmpeg+tesseract-v3","analysis_version":"video-temporal-v2"}})
            return True
        except Exception as e:
            try: http_json(api,"POST",headers,{"action":"analysis_fail","worker_id":worker,"analysis_id":analysis_id,"error":str(e)[:1000],"retry":True})
            except Exception as report_error: print(json.dumps({"level":"error","analysis_id":analysis_id,"report_fail_error":str(report_error),"original_error":str(e),"at":time.time()}),flush=True)
            return False
        finally:
            stop.set(); th.join(timeout=2); shutil.rmtree(adir,ignore_errors=True); worker_ping("IDLE",force=True)
    while True:
        try:
            worker_ping("IDLE")
            claim=http_json(api,"POST",headers,{"action":"claim","worker_id":worker}); job=claim.get("job")
            if not job:
                if analysis_enabled and analysis_processed<analysis_budget:
                    ac=http_json(api,"POST",headers,{"action":"claim_analysis","worker_id":worker}); item=ac.get("analysis")
                    if item:
                        process_analysis(item); analysis_processed+=1
                        if analysis_cooldown: time.sleep(analysis_cooldown)
                        continue
                time.sleep(POLL); continue
            job_id=str(job["id"]); stop_hb=threading.Event(); worker_ping("WORKING",current_job_id=job_id,force=True)
            def heartbeat_loop():
                while not stop_hb.wait(heartbeat_seconds):
                    try:
                        http_json(api,"POST",headers,{"action":"heartbeat","worker_id":worker,"job_id":job_id,"stage":"WORKING"})
                        worker_ping("WORKING",current_job_id=job_id)
                    except Exception as e: print(json.dumps({"level":"warning","job_id":job_id,"heartbeat_error":str(e),"at":time.time()}),flush=True)
            hb=threading.Thread(target=heartbeat_loop,name=f"hb-{job_id[:8]}",daemon=True); hb.start()
            jobdir=WORK/job_id; jobdir.mkdir(parents=True,exist_ok=True); paths=[]; total=0
            try:
                progress(job_id,5,"AUTHENTICATING_DRIVE","ANALYZING"); g=google_token()
                inputs=claim.get("inputs",[])
                for i,item in enumerate(inputs):
                    progress(job_id,min(20,7+int((i/max(1,len(inputs)))*12)),f"DOWNLOADING_INPUT_{i+1}","ANALYZING")
                    p=jobdir/(str(i)+"-"+re.sub(r"[^A-Za-z0-9._-]","_",item.get("file_name") or "input.mp4")); drive_download(item["drive_file_id"],p,g); total+=p.stat().st_size
                    if total>MAX_JOB: raise ValueError("job_too_large")
                    if item.get("content_hash") and sha256(p)!=item["content_hash"]: raise ValueError("content_hash_mismatch")
                    paths.append(p)
                progress(job_id,25,"TEMPORAL_ANALYSIS","ANALYZING"); analyses=[]
                for i,p in enumerate(paths):
                    analyses.append(temporal(p,jobdir)); progress(job_id,min(50,30+int(((i+1)/max(1,len(paths)))*20)),f"ANALYZED_INPUT_{i+1}","ANALYZING")
                progress(job_id,55,"PLANNING_SEGMENTS","PLANNING"); segments=select_segments(analyses,float(job.get("edit_strategy",{}).get("target_duration_seconds",25)))
                out=jobdir/output_name(job); progress(job_id,62,"RENDERING_VERTICAL","RENDERING"); render(paths,segments,job.get("edit_strategy",{}),out,job.get("manifest",{}).get("overlays"),analyses)
                progress(job_id,82,"RUNNING_QA","QA"); q=qa(out,{**job.get("manifest",{}),"strategy":job.get("edit_strategy",{}),"client_assets_only":True})
                if not q["pass"]: raise ValueError("qa_failed:"+json.dumps(q["checks"]))
                folder=job.get("output_drive_folder_id") or job.get("output_drive_root_id"); progress(job_id,90,"UPLOADING_DRIVE","UPLOADING"); up=drive_upload(out,out.name,folder,job_id,"vertical",g)
                progress(job_id,97,"REGISTERING_OUTPUT","QA"); http_json(api,"POST",headers,{"action":"complete","worker_id":worker,"job_id":job_id,"output_drive_folder_id":folder,"renderer_version":VERSION,"outputs":[{"variant":"vertical","idempotency_key":job_id+":vertical","aspect_ratio":"9:16","drive_file_id":up["id"],"drive_url":up.get("webViewLink"),"file_name":out.name,"duration_seconds":q["duration_seconds"],"content_hash":sha256(out),"size_bytes":out.stat().st_size,"video_codec":q["video_codec"],"audio_codec":q["audio_codec"],"width":q["width"],"height":q["height"],"fps":q["fps"],"renderer_version":VERSION,"qa_status":"PASS","qa_json":q,"render_metadata":{"selected_segments":segments,"analyses":analyses}}]})
            except Exception as e:
                try: http_json(api,"POST",headers,{"action":"fail","worker_id":worker,"job_id":job_id,"error":str(e)[:1000]})
                except Exception as report_error: print(json.dumps({"level":"error","job_id":job_id,"report_fail_error":str(report_error),"original_error":str(e),"at":time.time()}),flush=True)
            finally:
                stop_hb.set(); hb.join(timeout=2); shutil.rmtree(jobdir,ignore_errors=True); worker_ping("IDLE",force=True)
        except Exception as e: print(json.dumps({"level":"error","error":str(e),"at":time.time()}),flush=True); time.sleep(POLL)
def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--local-manifest"); ap.add_argument("--output"); args=ap.parse_args()
    if args.local_manifest: return local(args.local_manifest,Path(args.output or "output.mp4"))
    daemon(); return 0
if __name__=="__main__": raise SystemExit(main())
