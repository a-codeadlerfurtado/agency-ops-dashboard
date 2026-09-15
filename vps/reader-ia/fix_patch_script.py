from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\fix_highlight_v8.py')
s=p.read_text(encoding='utf-8')
s=s.replace("print('MATCHER_PATCHED')s=p.read_text", "print('MATCHER_PATCHED')\ns=p.read_text")
s=s.replace("print('RENDERER_PATCHED')idx=Path", "print('RENDERER_PATCHED')\nidx=Path")
p.write_text(s,encoding='utf-8')
print('SCRIPT_FIXED')