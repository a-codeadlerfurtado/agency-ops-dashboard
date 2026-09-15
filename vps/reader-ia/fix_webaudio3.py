from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="""function toggleSpeech(){
  if(!speaking){startSpeech();return;}
  if(!paused){
    paused=true;if(currentAudio)currentAudio.pause();else speechSynthesis.pause();$('play').textContent='▶ Continuar';
  }else{
    paused=false;$('play').textContent='⏸ Pausar';
    if(currentAudio)currentAudio.play();else if($('voice').value==='system:browser')speechSynthesis.resume();else speakCurrentSentence();
  }
}"""
new="""function toggleSpeech(){
  if(!speaking){
    if($('voice').value!=='system:browser') ensureAudioContext();
    startSpeech();return;
  }
  if(!paused){
    paused=true;
    if($('voice').value==='system:browser') speechSynthesis.pause();
    else if(audioContext?.state==='running') audioContext.suspend();
    $('play').textContent='▶ Continuar';
  }else{
    paused=false;$('play').textContent='⏸ Pausar';
    if($('voice').value==='system:browser') speechSynthesis.resume();
    else if(currentSource) ensureAudioContext(); else {ensureAudioContext();speakCurrentSentence();}
  }
}"""
if old not in s: raise SystemExit('toggle block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('toggle WebAudio unlock added')