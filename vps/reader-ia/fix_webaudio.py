from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("let currentAudio=null,currentAudioUrl=null,audioRequestToken=0;", "let currentAudio=null,currentAudioUrl=null,audioRequestToken=0;\nlet audioContext=null,currentSource=null,currentBuffer=null;")
needle="function cleanupAudio(){\n  if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}\n  if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}\n}"
replacement="""function ensureAudioContext(){
  if(!audioContext) audioContext=new (window.AudioContext||window.webkitAudioContext)();
  if(audioContext.state==='suspended') return audioContext.resume();
  return Promise.resolve();
}
function cleanupAudio(){
  if(currentSource){currentSource.onended=null;try{currentSource.stop()}catch{};try{currentSource.disconnect()}catch{};currentSource=null;}
  currentBuffer=null;
  if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}
  if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}
}"""
if needle not in s: raise SystemExit('cleanup needle not found')
s=s.replace(needle,replacement)
p.write_text(s,encoding='utf-8')
print('webaudio base added')