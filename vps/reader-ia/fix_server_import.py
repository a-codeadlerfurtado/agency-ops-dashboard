from pathlib import Path
p=Path('server.py');s=p.read_text(encoding='utf-8')
if 'import re\n' not in s:s=s.replace('import os\n','import os\nimport re\n',1)
p.write_text(s,encoding='utf-8')
print('server re import ensured')
