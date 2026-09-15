from pathlib import Path
import re
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8-sig')
anchor='APP = Path("/app/app-v2.mjs") if Path("/app/app-v2.mjs").exists() else Path(__file__).with_name("app-v2.mjs")\n'
add='MANIFEST = Path("/app/manifest.webmanifest") if Path("/app/manifest.webmanifest").exists() else Path(__file__).with_name("manifest.webmanifest")\nSW = Path("/app/sw.js") if Path("/app/sw.js").exists() else Path(__file__).with_name("sw.js")\nASSET_ROOT = Path("/app/assets") if Path("/app/assets").exists() else Path(__file__).with_name("assets")\n'
if 'MANIFEST = Path(' not in s:s=s.replace(anchor,anchor+add,1)
p.write_text(s,encoding='utf-8')
print('paths patched')s=p.read_text(encoding='utf-8')
s=s.replace('"prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[])','"prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[]),\n            "coverUrl": "/reader/assets/cover-kotler.jpg" if str(profile.get("id","")).startswith("kotler") else "/reader/assets/cover-zikmund.jpg"',1)
marker='    def do_GET(self):\n'
helper='''    def serve_file(self, fp, content_type, cache_control="public, max-age=86400", allow_range=False):
        fp=Path(fp); size=fp.stat().st_size; start=0; end=size-1; status=200
        range_header=self.headers.get("Range","") if allow_range else ""
        m=re.match(r"bytes=(\\d*)-(\\d*)",range_header)
        if m:
            if m.group(1): start=int(m.group(1))
            if m.group(2): end=min(end,int(m.group(2)))
            if start>end or start>=size:
                self.send_response(416); self.send_header("Content-Range",f"bytes */{size}"); self.end_headers(); return
            status=206
        length=end-start+1; self.send_response(status); self.send_header("Content-Type",content_type); self.send_header("Content-Length",str(length)); self.send_header("Cache-Control",cache_control)
        if allow_range:
            self.send_header("Accept-Ranges","bytes")
            if status==206:self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.end_headers()
        with fp.open("rb") as src:
            src.seek(start); remaining=length
            while remaining>0:
                chunk=src.read(min(1024*1024,remaining))
                if not chunk: break
                self.wfile.write(chunk); remaining-=len(chunk)

'''
if 'def serve_file(self, fp' not in s:s=s.replace(marker,helper+marker,1)
p.write_text(s,encoding='utf-8')
print('helper patched')s=p.read_text(encoding='utf-8')
old='''        if path.startswith("/api/library/book/"):
            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])
            fp=library_path_for(book_id)
            if not fp:return self.send_json(404,{"error":"book_not_available"})
            size=fp.stat().st_size
            self.send_response(200);self.send_header("Content-Type","application/pdf");self.send_header("Content-Length",str(size));self.send_header("Cache-Control","public, max-age=86400");self.end_headers()
            with fp.open("rb") as src:shutil.copyfileobj(src,self.wfile,1024*1024)
            return
'''
new='''        if path.startswith("/api/library/book/"):
            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])
            fp=library_path_for(book_id)
            if not fp:return self.send_json(404,{"error":"book_not_available"})
            return self.serve_file(fp,"application/pdf","public, max-age=86400",allow_range=True)
        if path == "/manifest.webmanifest":
            return self.serve_file(MANIFEST,"application/manifest+json","no-cache")
        if path == "/sw.js":
            return self.serve_file(SW,"text/javascript; charset=utf-8","no-cache")
        if path.startswith("/assets/"):
            name=Path(path.split("/assets/",1)[1]).name; fp=ASSET_ROOT/name
            if not fp.exists(): return self.send_error(404)
            ctype="image/png" if fp.suffix.lower()==".png" else "image/jpeg"
            return self.serve_file(fp,ctype,"public, max-age=31536000, immutable")
'''
if old not in s: raise SystemExit('library route block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('routes patched')