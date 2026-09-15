from pathlib import Path
base=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
server=base/'server.py'
s=server.read_text(encoding='utf-8')
old='return self.serve_file(fp,"image/png" if fp.suffix.lower()==".png" else "image/jpeg","public, max-age=31536000, immutable")'
new='ctype={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".mp3":"audio/mpeg"}.get(fp.suffix.lower(),"application/octet-stream")\n            return self.serve_file(fp,ctype,"public, max-age=31536000, immutable")'
assert old in s
s=s.replace(old,new,1)
server.write_text(s,encoding='utf-8')
print('server asset mime patched')

deploy=base/'deploy-reader-app2.ps1'
d=deploy.read_text(encoding='utf-8-sig')
d=d.replace("(Join-Path $dir 'app-v2-fixed.mjs')","(Join-Path $dir 'app-v2-mobile.mjs')",1)
needle='$icon512Cfg=New-DockerConfig "reader-ia-icon512-$stamp" (Join-Path $dir \'assets\\icon-512.png\')'
repl=needle+'\n$silenceCfg=New-DockerConfig "reader-ia-silence-$stamp" (Join-Path $dir \'assets\\silence.mp3\')'
assert needle in d
d=d.replace(needle,repl,1)
needle='@{ConfigID=$icon512Cfg.ID;ConfigName="reader-ia-icon512-$stamp";File=@{Name=\'/app/assets/icon-512.png\';UID=\'0\';GID=\'0\';Mode=292}}'
repl=needle+',\n        @{ConfigID=$silenceCfg.ID;ConfigName="reader-ia-silence-$stamp";File=@{Name=\'/app/assets/silence.mp3\';UID=\'0\';GID=\'0\';Mode=292}}'
assert needle in d
d=d.replace(needle,repl,1)
deploy.write_text(d,encoding='utf-8-sig')
print('deploy mobile source patched')

sw=base/'sw.js'
w=sw.read_text(encoding='utf-8')
w=w.replace("readerpro-shell-v3","readerpro-shell-v4")
w=w.replace("'/reader/assets/cover-zikmund.jpg'","'/reader/assets/cover-zikmund.jpg','/reader/assets/silence.mp3'")
sw.write_text(w,encoding='utf-8')
print('sw cache bumped')