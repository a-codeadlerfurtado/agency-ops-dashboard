from pathlib import Path
p=Path('app-v2.mjs');s=p.read_text(encoding='utf-8')
old="function toggleSpeech(){if(!speaking){if($('voice').value!=='system:browser')ensureAudioContext();startSpeech();return;}if(!paused){paused=true;if($('voice').value==='system:browser')speechSynthesis.pause();else if(audioContext?.state==='running')audioContext.suspend();$('play').textContent='▶ Continuar';}else{paused=false;$('play').textContent='⏸ Pausar';if($('voice').value==='system:browser')speechSynthesis.resume();else ensureAudioContext();}}"
new="function toggleSpeech(){if(!speaking){if($('voice').value!=='system:browser')ensureAudioContext();startSpeech();return;}if(!paused){paused=true;saveProgress();if($('voice').value==='system:browser')speechSynthesis.pause();else if(audioContext?.state==='running')audioContext.suspend();$('play').textContent='▶ Continuar';}else{paused=false;$('play').textContent='⏸ Pausar';if($('voice').value==='system:browser')speechSynthesis.resume();else ensureAudioContext().then(()=>{if(!audioTimeline.length)startLocalContinuous();});}}"
if old not in s: raise SystemExit('toggleSpeech block missing')
s=s.replace(old,new,1)
old2="restoreProgress();await loadSavedAnalysis();if(pendingVoice"
new2="restoreProgress();updateAudiobookUi();await loadSavedAnalysis();if(pendingVoice"
if old2 not in s: raise SystemExit('file restore anchor missing')
s=s.replace(old2,new2,1)
p.write_text(s,encoding='utf-8')
print('runtime pause/resume + audiobook ui fixed')
