from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\public.html')
print('EXISTS',p.exists(),'SIZE',p.stat().st_size if p.exists() else 0)
h=p.read_text(encoding='utf-8',errors='ignore') if p.exists() else ''
for name,needle in [('READERPRO','<title>ReaderPro</title>'),('WEBAUDIO','decodeAudioData'),('PDF_CLEAN','cleanPdfText'),('CONTEXT_PAYLOAD',"mode:'editorial'"),('OLD_AUDIO_PLAYER','currentAudio=new Audio')]:
    print(name,needle in h)