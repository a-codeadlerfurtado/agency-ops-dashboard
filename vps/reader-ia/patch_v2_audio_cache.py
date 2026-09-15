from pathlib import Path
p=Path('index.html');s=p.read_text(encoding='utf-8')
start=s.index('async function getLocalAudio(text){')
end=s.index('\nfunction trimAudioBuffer',start)
new=r'''function prepareNarrationText(text){
  return String(text||'')
    .replace(/[•▪◦]/g,'. ')
    .replace(/US\$\s*([\d.,]+)/gi,'$1 dólares')
    .replace(/R\$\s*([\d.,]+)/gi,'$1 reais')
    .replace(/([\d.,]+)\s*%/g,'$1 por cento')
    .replace(/\s*&\s*/g,' e ')
    .replace(/\bn[º°]\s*/gi,'número ')
    .replace(/\bvs\.?(?=\s|$)/gi,'versus')
    .replace(/[—–]+/g,', ')
    .replace(/\s+/g,' ').trim();
}
async function getLocalAudio(text){
  const voice=$('voice').value,spoken=prepareNarrationText(text),speed=1;
  const key=`${voice}|${spoken}`;
  if(audioCache.has(key))return audioCache.get(key);
  if(audioPending.has(key))return audioPending.get(key);
  const pending=(async()=>{
    const persistent=`audio:${voice}:${hashText(spoken)}:${spoken.length}`;
    const saved=await dbGet(persistent);if(saved instanceof Blob){audioCache.set(key,saved);return saved;}
    const res=await fetch(BASE+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:spoken,voice,speed})});
    if(!res.ok){let d={};try{d=await res.json()}catch{};throw new Error(d.detail||d.error||`TTS ${res.status}`);}
    const blob=await res.blob();audioCache.set(key,blob);dbPut(persistent,blob);
    if(audioCache.size>100)audioCache.delete(audioCache.keys().next().value);return blob;
  })();
  audioPending.set(key,pending);try{return await pending;}finally{audioPending.delete(key);}
}
'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('narration prep + persistent audio cache patched')
