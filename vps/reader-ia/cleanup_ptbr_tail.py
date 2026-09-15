from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8')
old='    return fix_concessive_subjunctive(out).strip()\n'
new='    out=re.sub(r"[,;:]?\\s+\\b(e|mas|ou|porque|que)\\.\\s*$", ".", out, flags=re.I)\n    return fix_concessive_subjunctive(out).strip()\n'
if old not in s: raise SystemExit('marker not found')
s=s.replace(old,new,1).replace('v11-ptbr|{TRANSLATION_MODEL}|','v12-ptbr|{TRANSLATION_MODEL}|')
p.write_text(s,encoding='utf-8')
q=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
t=q.read_text(encoding='utf-8').replace('translation:v6-ptbr-review:','translation:v7-ptbr-review:')
q.write_text(t,encoding='utf-8')
print('cleanup + cache bump done')