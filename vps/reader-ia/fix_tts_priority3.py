from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("currentAudio.onplay=()=>{setBuffer('voz local • buffer pronto',true);updateSentenceHighlight();prebufferUpcoming(3);};","currentAudio.onplay=()=>{setBuffer('voz local • lendo',true);updateSentenceHighlight();setTimeout(()=>prebufferUpcoming(2),250);};")
s=s.replace("speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateSentenceHighlight();prebufferUpcoming(3);speakCurrentSentence();","speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateSentenceHighlight();speakCurrentSentence();")
s=s.replace("function stopSpeech(){\n  audioRequestToken++;cleanupAudio();speechSynthesis.cancel();","function stopSpeech(){\n  audioRequestToken++;prebufferGeneration++;cleanupAudio();speechSynthesis.cancel();")
p.write_text(s,encoding='utf-8')
print('current sentence now has priority')