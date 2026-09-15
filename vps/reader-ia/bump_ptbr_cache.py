from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8').replace('v10|{TRANSLATION_MODEL}|','v11-ptbr|{TRANSLATION_MODEL}|')
p.write_text(s,encoding='utf-8')
q=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
t=q.read_text(encoding='utf-8').replace('translation:v5-ptbr-review:','translation:v6-ptbr-review:')
q.write_text(t,encoding='utf-8')
print('cache versions bumped')