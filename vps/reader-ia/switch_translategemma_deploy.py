from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader.ps1')
s=p.read_text(encoding='utf-8')
s=s.replace("ollama pull qwen2.5:3b; wait $pid", "ollama pull translategemma:4b; ollama pull qwen2.5:3b; wait $pid")
s=s.replace("'TRANSLATION_MODEL=qwen2.5:3b'", "'TRANSLATION_MODEL=translategemma:4b'")
p.write_text(s,encoding='utf-8')
print('deploy switched to TranslateGemma primary')