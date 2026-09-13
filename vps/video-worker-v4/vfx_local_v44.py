from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np

VFX_LOCAL_VERSION = "local-vfx-v4.4.0"


def _open(path):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"vfx_open_failed:{path}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    return cap, fps, width, height


def _writer(path, fps, width, height, gray=False):
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    w = cv2.VideoWriter(str(path), fourcc, fps, (width, height), not gray)
    if not w.isOpened():
        raise RuntimeError(f"vfx_writer_failed:{path}")
    return w


def _px_point(p, w, h):
    x, y = float(p[0]), float(p[1])
    if abs(x) <= 1.5 and abs(y) <= 1.5:
        return np.array([x * w, y * h], dtype=np.float32)
    return np.array([x, y], dtype=np.float32)


def _quad(params, w, h):
    q = params.get("quad") or params.get("corners")
    if q and len(q) == 4:
        return np.array([_px_point(p, w, h) for p in q], dtype=np.float32)
    bbox = params.get("bbox") or [0.2, 0.2, 0.6, 0.5]
    x, y, bw, bh = _bbox(bbox, w, h)
    return np.array([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]], dtype=np.float32)


def _bbox(bbox, w, h):
    x, y, bw, bh = [float(v) for v in bbox]
    if max(abs(x), abs(y), abs(bw), abs(bh)) <= 1.5:
        x, bw = x * w, bw * w
        y, bh = y * h, bh * h
    x = int(max(0, min(w - 2, x)))
    y = int(max(0, min(h - 2, y)))
    bw = int(max(2, min(w - x, bw)))
    bh = int(max(2, min(h - y, bh)))
    return x, y, bw, bh


def _tracker():
    if hasattr(cv2, "TrackerCSRT_create"):
        return cv2.TrackerCSRT_create()
    if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerCSRT_create"):
        return cv2.legacy.TrackerCSRT_create()
    if hasattr(cv2, "TrackerKCF_create"):
        return cv2.TrackerKCF_create()
    raise RuntimeError("opencv_tracker_unavailable")


def track_bbox(video_path, bbox):
    cap, fps, w, h = _open(video_path)
    ok, frame = cap.read()
    if not ok:
        cap.release()
        raise RuntimeError("tracking_first_frame_failed")
    box = _bbox(bbox, w, h)
    tracker = _tracker()
    tracker.init(frame, tuple(float(v) for v in box))
    rows = [{"frame": 0, "time": 0.0, "bbox": [box[0] / w, box[1] / h, box[2] / w, box[3] / h], "ok": True}]
    index = 1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        good, b = tracker.update(frame)
        if good:
            x, y, bw, bh = _bbox(b, w, h)
            rows.append({"frame": index, "time": index / fps, "bbox": [x / w, y / h, bw / w, bh / h], "ok": True})
        else:
            rows.append({"frame": index, "time": index / fps, "bbox": rows[-1]["bbox"], "ok": False})
        index += 1
    cap.release()
    return {"available": True, "version": VFX_LOCAL_VERSION, "fps": fps, "width": w, "height": h, "frames": rows}


def _tracked_quads(cap, first, q0):
    prev_gray = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    points = q0.reshape(-1, 1, 2).astype(np.float32)
    yield q0.copy()
    while True:
        ok, frame = cap.read()
        if not ok:
            return
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, points, None, winSize=(31, 31), maxLevel=3,
                                              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
        if nxt is not None and st is not None and int(st.sum()) >= 3:
            good_old = points[st == 1].reshape(-1, 2)
            good_new = nxt[st == 1].reshape(-1, 2)
            H, _ = cv2.findHomography(good_old, good_new, cv2.RANSAC, 3.0) if len(good_old) >= 4 else (None, None)
            if H is not None:
                corners = cv2.perspectiveTransform(q0.reshape(-1, 1, 2), H).reshape(-1, 2)
            else:
                delta = np.median(good_new - good_old, axis=0)
                corners = q0 + delta
            points = corners.reshape(-1, 1, 2).astype(np.float32)
            q0 = corners.astype(np.float32)
        prev_gray = gray
        yield q0.copy()


def _overlay_quad(frame, asset, quad, alpha=1.0):
    h, w = asset.shape[:2]
    src = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, quad.astype(np.float32))
    warped = cv2.warpPerspective(asset, H, (frame.shape[1], frame.shape[0]))
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), H, (frame.shape[1], frame.shape[0]))
    mask = cv2.GaussianBlur(mask, (0, 0), 1.2)
    a = (mask.astype(np.float32) / 255.0 * float(alpha))[..., None]
    return np.clip(frame.astype(np.float32) * (1 - a) + warped.astype(np.float32) * a, 0, 255).astype(np.uint8)


def screen_replace(video_path, output_path, params):
    asset_path = params.get("asset_path") or params.get("replacement_path")
    if not asset_path or not Path(asset_path).exists():
        raise RuntimeError("screen_replace_asset_missing")
    asset = cv2.imread(str(asset_path), cv2.IMREAD_COLOR)
    if asset is None:
        raise RuntimeError("screen_replace_asset_invalid")
    cap, fps, w, h = _open(video_path)
    ok, first = cap.read()
    if not ok:
        raise RuntimeError("screen_replace_first_frame_failed")
    q = _quad(params, w, h)
    writer = _writer(output_path, fps, w, h)
    alpha = float(params.get("alpha", 0.96))
    quads = _tracked_quads(cap, first, q)
    writer.write(_overlay_quad(first, asset, next(quads), alpha))
    for quad in quads:
        frame = cap.retrieve()[1] if False else None
        # _tracked_quads consumes frames; reopen below for deterministic compositing.
        break
    cap.release(); writer.release()
    # Second pass tracks and composites in one loop.
    cap, fps, w, h = _open(video_path)
    writer = _writer(output_path, fps, w, h)
    ok, frame = cap.read()
    prev = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    current = q.copy()
    writer.write(_overlay_quad(frame, asset, current, alpha))
    while True:
        ok, nxtf = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(nxtf, cv2.COLOR_BGR2GRAY)
        p0 = current.reshape(-1, 1, 2).astype(np.float32)
        p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, gray, p0, None, winSize=(31,31), maxLevel=3)
        if p1 is not None and st is not None and int(st.sum()) >= 3:
            delta = np.median((p1[st==1] - p0[st==1]).reshape(-1,2), axis=0)
            current = current + delta
        writer.write(_overlay_quad(nxtf, asset, current, alpha))
        prev = gray
    cap.release(); writer.release()
    return {"available": True, "version": VFX_LOCAL_VERSION, "effect": "screen_replacement"}


def perspective_text(video_path, output_path, params):
    text = str(params.get("text") or "").strip()
    if not text:
        raise RuntimeError("perspective_text_missing_text")
    canvas = np.zeros((360, 1280, 3), dtype=np.uint8)
    font = cv2.FONT_HERSHEY_DUPLEX
    scale = max(0.6, min(2.8, float(params.get("scale", 1.8))))
    thickness = max(1, int(params.get("thickness", 3)))
    cv2.putText(canvas, text[:80], (32, 220), font, scale, (245,245,245), thickness, cv2.LINE_AA)
    p = dict(params); p["asset_path"] = str(Path(output_path).with_suffix(".perspective-text.jpg"))
    cv2.imwrite(p["asset_path"], canvas)
    try:
        return screen_replace(video_path, output_path, p)
    finally:
        Path(p["asset_path"]).unlink(missing_ok=True)


def _grabcut_mask(frame, bbox):
    h, w = frame.shape[:2]
    rect = _bbox(bbox, w, h)
    mask = np.zeros((h, w), np.uint8)
    bg = np.zeros((1, 65), np.float64); fg = np.zeros((1, 65), np.float64)
    cv2.grabCut(frame, mask, rect, bg, fg, 4, cv2.GC_INIT_WITH_RECT)
    out = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    out = cv2.morphologyEx(out, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
    out = cv2.GaussianBlur(out, (0,0), 1.4)
    return out


def segment(video_path, output_path, params):
    bbox = params.get("bbox") or [0.25, 0.2, 0.5, 0.65]
    tracking = track_bbox(video_path, bbox)
    cap, fps, w, h = _open(video_path)
    writer = _writer(output_path, fps, w, h)
    rows = tracking["frames"]
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        b = rows[min(i, len(rows)-1)]["bbox"]
        mask = _grabcut_mask(frame, b)
        rgb = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
        writer.write(rgb)
        i += 1
    cap.release(); writer.release()
    return {"available": True, "version": VFX_LOCAL_VERSION, "effect": "segmentation", "frames": i}


def text_behind_object(video_path, output_path, params):
    text = str(params.get("text") or "").strip()
    bbox = params.get("bbox")
    if not text or not bbox:
        raise RuntimeError("text_behind_object_needs_text_and_bbox")
    tracking = track_bbox(video_path, bbox)
    cap, fps, w, h = _open(video_path)
    writer = _writer(output_path, fps, w, h)
    rows = tracking["frames"]
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        b = rows[min(i, len(rows)-1)]["bbox"]
        mask = _grabcut_mask(frame, b)
        layer = frame.copy()
        font_scale = max(0.7, min(3.2, float(params.get("scale", 1.6))))
        x = int(float(params.get("x", 0.08)) * w if float(params.get("x",0.08)) <= 1.5 else float(params.get("x")))
        y = int(float(params.get("y", 0.55)) * h if float(params.get("y",0.55)) <= 1.5 else float(params.get("y")))
        cv2.putText(layer, text[:80], (x, y), cv2.FONT_HERSHEY_DUPLEX, font_scale, (250,250,250), max(2,int(font_scale*2)), cv2.LINE_AA)
        textdiff = cv2.absdiff(layer, frame)
        textmask = cv2.cvtColor(textdiff, cv2.COLOR_BGR2GRAY)
        textmask = (textmask > 3).astype(np.uint8) * 255
        visible = cv2.bitwise_and(textmask, cv2.bitwise_not(mask))
        a = (cv2.GaussianBlur(visible, (0,0), 0.8).astype(np.float32)/255.0)[...,None]
        out = np.clip(frame*(1-a)+layer*a,0,255).astype(np.uint8)
        writer.write(out); i += 1
    cap.release(); writer.release()
    return {"available": True, "version": VFX_LOCAL_VERSION, "effect": "text_behind_object", "frames": i}


def sky_replace(video_path, output_path, params):
    replacement = None
    rp = params.get("asset_path") or params.get("replacement_path")
    if rp and Path(rp).exists():
        replacement = cv2.imread(str(rp), cv2.IMREAD_COLOR)
    cap, fps, w, h = _open(video_path)
    writer = _writer(output_path, fps, w, h)
    while True:
        ok, frame = cap.read()
        if not ok: break
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        H,S,V = cv2.split(hsv)
        top = np.zeros((h,w), np.uint8); top[:int(h*0.62),:] = 255
        blue = (((H >= 82) & (H <= 135) & (S >= 35) & (V >= 80)) * 255).astype(np.uint8)
        pale = (((S < 58) & (V > 185)) * 255).astype(np.uint8)
        mask = cv2.bitwise_and(cv2.bitwise_or(blue,pale), top)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9,9),np.uint8))
        mask = cv2.GaussianBlur(mask,(0,0),3.2)
        if replacement is None:
            repl = frame.copy().astype(np.float32)
            repl[:,:,0] = np.clip(repl[:,:,0]*1.15+18,0,255)
            repl[:,:,1] = np.clip(repl[:,:,1]*1.05+6,0,255)
            repl[:,:,2] = np.clip(repl[:,:,2]*0.96,0,255)
            repl = repl.astype(np.uint8)
        else:
            repl = cv2.resize(replacement,(w,h),interpolation=cv2.INTER_CUBIC)
        a = (mask.astype(np.float32)/255.0*float(params.get("strength",0.82)))[...,None]
        writer.write(np.clip(frame*(1-a)+repl*a,0,255).astype(np.uint8))
    cap.release(); writer.release()
    return {"available": True, "version": VFX_LOCAL_VERSION, "effect": "sky_replacement"}


def day_to_dusk(video_path, output_path, params):
    cap, fps, w, h = _open(video_path); writer = _writer(output_path,fps,w,h)
    strength=max(0.0,min(1.0,float(params.get("strength",0.68))))
    while True:
        ok, frame=cap.read()
        if not ok: break
        f=frame.astype(np.float32)/255.0
        dusk=np.power(f,1.18+0.35*strength)
        dusk[:,:,0]=np.clip(dusk[:,:,0]*(1.10+0.18*strength)+0.025*strength,0,1)
        dusk[:,:,1]=np.clip(dusk[:,:,1]*(0.90-0.08*strength),0,1)
        dusk[:,:,2]=np.clip(dusk[:,:,2]*(0.78-0.10*strength),0,1)
        hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV); H,S,V=cv2.split(hsv)
        lights=((V>185)&(S<105)).astype(np.float32)[...,None]
        warm=np.zeros_like(dusk); warm[:,:,0]=0.18; warm[:,:,1]=0.58; warm[:,:,2]=1.0
        dusk=np.clip(dusk*(1-lights*0.24*strength)+warm*lights*0.24*strength,0,1)
        writer.write((dusk*255).astype(np.uint8))
    cap.release(); writer.release(); return {"available":True,"version":VFX_LOCAL_VERSION,"effect":"day_to_dusk","requires_disclosure":True}


def lights_on(video_path, output_path, params):
    cap,fps,w,h=_open(video_path); writer=_writer(output_path,fps,w,h)
    strength=max(0.0,min(1.0,float(params.get("strength",0.55))))
    while True:
        ok,frame=cap.read()
        if not ok: break
        hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV); H,S,V=cv2.split(hsv)
        mask=((V>145)&(S<90)).astype(np.uint8)*255
        mask=cv2.GaussianBlur(mask,(0,0),5.0)
        warm=frame.astype(np.float32); warm[:,:,2]=np.clip(warm[:,:,2]+55*strength,0,255); warm[:,:,1]=np.clip(warm[:,:,1]+24*strength,0,255)
        a=(mask.astype(np.float32)/255.0*0.48*strength)[...,None]
        writer.write(np.clip(frame*(1-a)+warm*a,0,255).astype(np.uint8))
    cap.release(); writer.release(); return {"available":True,"version":VFX_LOCAL_VERSION,"effect":"lights_on","requires_disclosure":True}


def object_remove(video_path, output_path, params):
    bbox=params.get("bbox")
    if not bbox: raise RuntimeError("object_removal_bbox_required")
    tracking=track_bbox(video_path,bbox); rows=tracking["frames"]
    cap,fps,w,h=_open(video_path); writer=_writer(output_path,fps,w,h); i=0
    radius=max(2,min(12,int(params.get("radius",5))))
    while True:
        ok,frame=cap.read()
        if not ok: break
        x,y,bw,bh=_bbox(rows[min(i,len(rows)-1)]["bbox"],w,h)
        mask=np.zeros((h,w),np.uint8); pad=max(2,int(min(bw,bh)*0.04)); cv2.rectangle(mask,(max(0,x-pad),max(0,y-pad)),(min(w-1,x+bw+pad),min(h-1,y+bh+pad)),255,-1)
        writer.write(cv2.inpaint(frame,mask,radius,cv2.INPAINT_TELEA)); i+=1
    cap.release(); writer.release(); return {"available":True,"version":VFX_LOCAL_VERSION,"effect":"object_removal","requires_disclosure":True,"frames":i}


def asset_overlay(video_path, output_path, params, effect):
    result=screen_replace(video_path,output_path,params); result["effect"]=effect; result["requires_disclosure"]=True; return result


def apply_effect(video_path, effect, params, output_path):
    effect=str(effect)
    if effect == "screen_replacement": return screen_replace(video_path,output_path,params)
    if effect == "perspective_text": return perspective_text(video_path,output_path,params)
    if effect == "text_behind_object": return text_behind_object(video_path,output_path,params)
    if effect == "segmentation": return segment(video_path,output_path,params)
    if effect in ("sky_replacement","sky_enhance"): return sky_replace(video_path,output_path,params)
    if effect == "day_to_dusk": return day_to_dusk(video_path,output_path,params)
    if effect == "lights_on": return lights_on(video_path,output_path,params)
    if effect in ("object_removal","object_cleanup"): return object_remove(video_path,output_path,params)
    if effect in ("room_staging","lot_to_project"):
        return asset_overlay(video_path,output_path,params,effect)
    raise RuntimeError(f"local_vfx_unsupported:{effect}")
