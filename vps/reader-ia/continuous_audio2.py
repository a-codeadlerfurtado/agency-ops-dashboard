from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
insert="""
function prebufferUpcoming(count=3){
  if($('voice').value==='system:browser') return;
  for(let i=1;i<=count;i++){
    const idx=sentenceIndex+i;
    if(idx<currentSentences.length) getLocalAudio(currentSentences[idx]).catch(()=>{});
  }
}
"""
marker="function advanceSentence(){"
if insert.strip() not in s:
    s=s.replace(marker,insert+marker)
s=s.replace("currentAudio.onplay=()=>{setBuffer('voz local',true);updateSentenceHighlight();};", "currentAudio.onplay=()=>{setBuffer('voz local • buffer pronto',true);updateSentenceHighlight();prebufferUpcoming(3);};")
s=s.replace("speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateSentenceHighlight();speakCurrentSentence();", "speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateSentenceHighlight();prebufferUpcoming(3);speakCurrentSentence();")
p.write_text(s,encoding='utf-8')
print('continuous buffer added')