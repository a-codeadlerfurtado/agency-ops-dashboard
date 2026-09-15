from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'app-v2.mjs'; s=p.read_text(encoding='utf-8')
s=s.replace('translation:v7-ptbr-review:','translation:v8-source-punctuation:')
p.write_text(s,encoding='utf-8')
q=root/'sw.js'; t=q.read_text(encoding='utf-8')
import re
t=re.sub(r"const CACHE='readerpro-shell-v\d+';","const CACHE='readerpro-shell-v16';",t)
q.write_text(t,encoding='utf-8')
print('punctuation caches bumped')