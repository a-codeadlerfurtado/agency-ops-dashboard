#!/usr/bin/env python3
import json, os, subprocess
from pathlib import Path
from urllib.request import Request, urlopen

subprocess.run([os.getenv("FFMPEG_BIN","ffmpeg"),"-version"],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
base=os.environ["SUPABASE_URL"].rstrip("/")+"/functions/v1/agency-ops-video-render-worker-api"
token=os.getenv("VIDEO_EDIT_WORKER_TOKEN") or (Path(os.environ["VIDEO_EDIT_WORKER_TOKEN_FILE"]).read_text(encoding="utf-8").strip() if os.getenv("VIDEO_EDIT_WORKER_TOKEN_FILE") else None)
if not token: raise SystemExit(3)
body=json.dumps({"action":"health","worker_id":os.getenv("VIDEO_WORKER_ID","leonardo-video-worker-v3")}).encode()
req=Request(base,data=body,headers={"content-type":"application/json","x-video-worker-token":token},method="POST")
with urlopen(req,timeout=8) as r:
    data=json.loads(r.read())
if not data.get("ok"): raise SystemExit(2)
print(json.dumps({"ok":True,"api_version":data.get("version"),"enabled":data.get("enabled")}))
