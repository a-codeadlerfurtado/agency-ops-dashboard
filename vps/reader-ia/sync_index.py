from pathlib import Path
import re
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
b=(root/'browser.mjs').read_text(encoding='utf-8-sig')
i=(root/'index.html').read_text(encoding='utf-8-sig')
m=re.search(r'(<script type="module">)(.*?)(</script>)',i,re.S)
if not m: raise SystemExit('module not found')
i=i[:m.start(2)]+'\n'+b.strip()+'\n'+i[m.end(2):]
(root/'index.html').write_text(i,encoding='utf-8')
print('INDEX_SYNCED')
