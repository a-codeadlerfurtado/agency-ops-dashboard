from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="""function cleanupAudio(){
  if(currentSource){currentSource.onended=null;try{currentSource.stop()}catch{};try{currentSource.disconnect()}catch{};currentSource=null;}
  currentBuffer=null;
  if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}
  if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}
}
function stopSpeech(){
  audioRequestToken++;prebufferGeneration++;cleanupAudio();speechSynthesis.cancel();
  speaking=false;paused=false;
  $('play').textContent='▶ Ouvir';$('play').classList.remove('playing');
  updateSentenceHighlight();
}"""
new="""function cleanupAudio(){
  clearScheduledAudio();
  if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}
  if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}
}
function stopSpeech(){
  audioRequestToken++;cleanupAudio();speechSynthesis.cancel();
  speaking=false;paused=false;
  $('play').textContent='▶ Ouvir';$('play').classList.remove('playing');
  updateSentenceHighlight();
}"""
if old not in s: raise SystemExit('cleanup block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('cleanup state patched')