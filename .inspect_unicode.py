from pathlib import Path
import unicodedata,collections
s=Path(r'C:\Users\Adler\agency-ops-dashboard-commercial-release\app\wrapped\story-engine.ts').read_text(encoding='utf-8')
c=collections.Counter(ch for ch in s if ord(ch)>127)
for ch,n in c.most_common():
 print(hex(ord(ch)),unicodedata.name(ch,'?'),n)
