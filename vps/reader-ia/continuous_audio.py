from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("const audioCache=new Map();", "const audioCache=new Map(),audioPending=new Map();")
old="""async function getLocalAudio(text){
  const voice=$('voice').value;
  const speed=Number($('rate').value)||1;
  const key=`${voice}|${speed}|${text}`;
  if(audioCache.has(key)) return audioCache.get(key);
  const res=await fetch(BASE+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice,speed})});
  if(!res.ok){let d={};try{d=await res.json()}catch{};throw new Error(d.detail||d.error||`TTS ${res.status}`);}
  const blob=await res.blob();
  audioCache.set(key,blob);
  if(audioCache.size>40) audioCache.delete(audioCache.keys().next().value);
  return blob;
}"""
new="""async function getLocalAudio(text){
  const voice=$('voice').value;
  const speed=Number($('rate').value)||1;
  const key=`${voice}|${speed}|${text}`;
  if(audioCache.has(key)) return audioCache.get(key);
  if(audioPending.has(key)) return audioPending.get(key);
  const pending=(async()=>{
    const res=await fetch(BASE+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice,speed})});
    if(!res.ok){let d={};try{d=await res.json()}catch{};throw new Error(d.detail||d.error||`TTS ${res.status}`);}
    const blob=await res.blob();
    audioCache.set(key,blob);
    if(audioCache.size>80) audioCache.delete(audioCache.keys().next().value);
    return blob;
  })();
  audioPending.set(key,pending);
  try{return await pending;}finally{audioPending.delete(key);}
}"""
if old not in s: raise SystemExit('getLocalAudio block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('part1')