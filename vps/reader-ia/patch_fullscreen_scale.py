from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8-sig')
old="scale=Math.min(2.2,maxW/v0.width)"
new="scale=Math.min(document.body.classList.contains('pdf-focus')?3.25:2.2,maxW/v0.width)"
if old not in s: raise SystemExit('scale anchor missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('fullscreen scale raised')