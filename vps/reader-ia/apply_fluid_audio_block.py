from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
block=Path('fluid_audio_block.txt').read_text(encoding='utf-8')
start=s.index('let prebufferGeneration=0;')
end=s.index('function startSpeech(){',start)
s=s[:start]+block+'\n'+s[end:]
p.write_text(s,encoding='utf-8')
print('continuous audio scheduler inserted')