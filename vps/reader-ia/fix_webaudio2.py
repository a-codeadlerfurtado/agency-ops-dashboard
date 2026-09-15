from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="""    currentAudioUrl=URL.createObjectURL(blob);currentAudio=new Audio(currentAudioUrl);
    currentAudio.onplay=()=>{setBuffer('voz local • buffer pronto',true);updateSentenceHighlight();prebufferUpcoming(2);};
    currentAudio.onended=()=>{cleanupAudio();advanceSentence();};
    currentAudio.onerror=()=>{setStatus('Falha ao reproduzir a voz local.');stopSpeech();};
    if(!paused) await currentAudio.play();"""
new="""    await ensureAudioContext();
    const bytes=await blob.arrayBuffer();
    if(token!==audioRequestToken||!speaking)return;
    currentBuffer=await audioContext.decodeAudioData(bytes.slice(0));
    if(token!==audioRequestToken||!speaking)return;
    currentSource=audioContext.createBufferSource();
    currentSource.buffer=currentBuffer;
    currentSource.connect(audioContext.destination);
    currentSource.onended=()=>{if(token!==audioRequestToken||!speaking)return;currentSource=null;advanceSentence();};
    setBuffer('voz local • Web Audio',true);updateSentenceHighlight();prebufferUpcoming(2);
    if(!paused) currentSource.start(0);"""
if old not in s: raise SystemExit('local playback block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('local playback changed to WebAudio')