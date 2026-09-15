from pathlib import Path
root = Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
index = root / 'index.html'
text = index.read_text(encoding='utf-8')
text = text.replace('Leonardo Reader IA', 'ReaderPro')
text = text.replace(".logo:after{content:'L'", ".logo:after{content:'R'")
index.write_text(text, encoding='utf-8')
wrangler = root / 'wrangler.reader.toml'
config = wrangler.read_text(encoding='utf-8')
config = config.replace('name = "leonardo-reader"', 'name = "readerpro"')
wrangler.write_text(config, encoding='utf-8')
print('ReaderPro rename applied')