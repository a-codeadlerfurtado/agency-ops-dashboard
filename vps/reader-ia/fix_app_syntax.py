from pathlib import Path
import os
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8-sig')
s=s.replace("});});\nwindow.addEventListener('keydown'","});\nwindow.addEventListener('keydown'",1)
t=p.with_name('app-v2-fixed.mjs')
t.write_text(s,encoding='utf-8')
os.replace(t,p)
print('FIXED',p.stat().st_size)