import json, os
from pathlib import Path
from urllib.request import Request, urlopen

def secret(name):
    value=os.getenv(name)
    if value:return value
    fp=os.getenv(name+"_FILE")
    return Path(fp).read_text(encoding="utf-8").strip() if fp else None

base=os.environ["SUPABASE_URL"].rstrip("/")+"/functions/v1/"+os.getenv("VIDEO_V4_API_SLUG","agency-ops-video-v4-worker-api")
token=secret("VIDEO_EDIT_WORKER_TOKEN")
if not token: raise SystemExit(3)
body=json.dumps({"action":"health","worker_id":os.getenv("VIDEO_WORKER_ID","leonardo-video-worker-v4-shadow")}).encode()
req=Request(base,data=body,headers={"content-type":"application/json","x-video-worker-token":token},method="POST")
with urlopen(req,timeout=8) as r:
    data=json.loads(r.read())
if not data.get("ok"): raise SystemExit(2)
