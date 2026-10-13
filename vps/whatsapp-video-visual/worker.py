"""Private outbound-only WhatsApp video frame extractor. No database/API secrets."""
import base64
import json
import math
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.request
from urllib.error import HTTPError

API = os.environ['MEDIA_VIDEO_API_URL']
TOKEN = pathlib.Path(os.getenv('MEDIA_VIDEO_TOKEN_FILE', '/run/secrets/media_video_token')).read_text().strip()
LIMIT = 25 * 1024 * 1024

def call(action, **payload):
    req = urllib.request.Request(API, data=json.dumps({'action': action, **payload}).encode(), headers={'content-type': 'application/json', 'x-media-video-token': TOKEN}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=150) as r:
            return json.load(r)
    except HTTPError as e:
        try:
            code = json.load(e).get('error', 'api_error')
        except Exception:
            code = 'api_error'
        raise RuntimeError('api_%s_%s' % (e.code, code)) from None

def run(args, timeout=60):
    r = subprocess.run(args, capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError('invalid_video')
    return r.stdout

def extract(job):
    # Gateway supplies only signed URLs to our private bucket.
    url = job['url']
    if not url.startswith('https://bfzdetibfcwihfkltbkp.supabase.co/storage/v1/object/sign/whatsapp-client-media/'):
        raise RuntimeError('invalid_storage_url')
    with tempfile.TemporaryDirectory(prefix='wa-video-') as directory:
        root = pathlib.Path(directory)
        src = root / 'original.mp4'
        size = 0
        with urllib.request.urlopen(url, timeout=60) as r, src.open('wb') as f:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > LIMIT:
                    raise RuntimeError('media_payload_too_large')
                f.write(chunk)
        probe = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(src)]))
        duration = float(probe.get('format', {}).get('duration', 0))
        if not math.isfinite(duration) or duration <= 0 or duration > 300:
            raise RuntimeError('duration_needs_review')
        if not any(s.get('codec_type') == 'video' for s in probe.get('streams', [])):
            raise RuntimeError('no_video_frames')
        count = min(12, max(2, math.ceil(duration / 10)))
        frames = []
        for i in range(count):
            timestamp = round((i + 0.5) * duration / count, 3)
            dst = root / ('frame-%02d.jpg' % i)
            run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-ss', str(timestamp), '-i', str(src), '-an', '-frames:v', '1', '-vf', "scale='min(768,iw)':-2", '-q:v', '5', '-y', str(dst)])
            if not dst.exists() or dst.stat().st_size > 300000:
                raise RuntimeError('no_video_frames')
            frames.append({'timestamp_seconds': timestamp, 'jpeg_base64': base64.b64encode(dst.read_bytes()).decode()})
        audio = None
        if not job.get('has_transcript') and any(s.get('codec_type') == 'audio' for s in probe.get('streams', [])):
            dst = root / 'audio.mp3'
            run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', str(src), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-y', str(dst)], 90)
            audio = base64.b64encode(dst.read_bytes()).decode()
        return {'frames': frames, 'duration_seconds': duration, 'audio_base64': audio}

def main():
    idle = 10
    while True:
        job = None
        try:
            pathlib.Path('/tmp/media-video-heartbeat').touch()
            job = call('claim').get('job')
            if not job:
                time.sleep(idle)
                idle = min(120, idle * 1.5)
                continue
            idle = 10
            result = call('complete', id=job['id'], lease=job['lease'], **extract(job))
            print(json.dumps({'event': 'video_visual_done', 'id': job['id'], 'frames': result.get('frames'), 'audio_coverage': result.get('audio_coverage')}), flush=True)
        except Exception as e:
            # Never log URLs, request payloads, tokens or media.
            error = str(e) if isinstance(e, RuntimeError) else type(e).__name__
            print(json.dumps({'event': 'video_visual_error', 'id': job.get('id') if job else None, 'error': error[:160]}), flush=True)
            if job:
                try:
                    call('fail', id=job['id'], lease=job['lease'], error=error[:160])
                except Exception:
                    pass
            time.sleep(30)
        if job:
            time.sleep(30)

if __name__ == '__main__':
    main()
