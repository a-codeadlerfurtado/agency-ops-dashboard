from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
s=(root/'deploy-reader-preanalysis.ps1').read_text(encoding='utf-8-sig')
s=s.replace("(Join-Path $dir 'server.py')","(Join-Path $dir 'server_preanalysis.py')",1)
out=root/'deploy-reader-preanalysis-v2.ps1'
out.write_text(s,encoding='utf-8')
print(out)
