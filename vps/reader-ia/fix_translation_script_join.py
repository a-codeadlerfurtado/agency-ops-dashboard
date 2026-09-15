from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\fix_translation_punct_v8.py')
s=p.read_text(encoding='utf-8')
s=s.replace("print('APP_PUNCT_OK')server=root/'server.py'", "print('APP_PUNCT_OK')\nserver=root/'server.py'")
p.write_text(s,encoding='utf-8')
print('JOIN_FIXED')