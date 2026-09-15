from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
start=s.index("async function speakCurrentSentence(){")
end=s.index("function startSpeech(){", start)
new=r'''async function speakCurrentSentence(){
  if(!speaking)return;
  if(sentenceIndex>=currentSentences.length){
    if(page<pdf.numPages)return loadPage(page+1,{autoplay:true});
    stopSpeech();$('progressBar').style.width='100%';$('progressText').textContent='Fim do documento';return;
  }
  if($('voice').value==='system:browser') return speakBrowserSentence();
  const token=++audioRequestToken;
  cleanupAudio();
  updateSentenceHighlight();
  setBuffer('gerando voz local');
  try{
    await ensureAudioContext();
    const blob=await getLocalAudio(currentSentences[sentenceIndex]);
    if(token!==audioRequestToken||!speaking)return;
    const bytes=await blob.arrayBuffer();
    currentBuffer=await audioContext.decodeAudioData(bytes.slice(0));
    if(token!==audioRequestToken||!speaking)return;
    currentSource=audioContext.createBufferSource();
    currentSource.buffer=currentBuffer;
    currentSource.connect(audioContext.destination);
    currentSource.onended=()=>{
      if(token!==audioRequestToken||!speaking)return;
      currentSource=null;
      advanceSentence();
    };
    setBuffer('voz local • lendo',true);
    updateSentenceHighlight();
    currentSource.start(0);
    setTimeout(()=>prebufferUpcoming(2),350);
  }catch(err){
    setStatus(`Voz local: ${err.message||err}`);
    stopSpeech();
  }
}
'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('WebAudio playback block replaced')