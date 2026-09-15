from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8').replace('app-v2.mjs?v=greene-native-clean-20260910','app-v2.mjs?v=crosspage-audio-buffer-20260910')
p.write_text(s,encoding='utf-8')
p=Path('sw.js')
s=p.read_text(encoding='utf-8').replace('readerpro-shell-v14-greene','readerpro-shell-v15-crosspage-audio')
p.write_text(s,encoding='utf-8')
print('cache_bust_ok')