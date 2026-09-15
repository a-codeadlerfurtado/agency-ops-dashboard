from pathlib import Path
p=Path('index.html');s=p.read_text(encoding='utf-8')
anchor='function updateSentenceHighlight(){\n'
insert=r'''function renderSegmentPairs(segments){
  currentSegments=segments.filter(x=>String(x?.target||'').trim());
  currentSentences=currentSegments.map(x=>String(x.target).trim());
  currentSourceSentences=currentSegments.map(x=>String(x.source||'').trim());
  sentenceIndex=pendingSentenceIndex===null?0:Math.min(Math.max(0,pendingSentenceIndex),Math.max(0,currentSentences.length-1));
  pendingSentenceIndex=null;
  const host=$('translation');host.innerHTML='';
  currentSentences.forEach((text,i)=>{
    const span=document.createElement('span');span.className='sentence';span.dataset.index=i;span.dataset.segmentId=String(currentSegments[i]?.id??i);span.textContent=text+' ';
    span.addEventListener('click',()=>{stopSpeech();sentenceIndex=i;currentSentenceOffset=0;startSpeech();});host.appendChild(span);
  });
  refreshSourceRanges();updateSentenceHighlight();
}
'''
if anchor not in s: raise SystemExit('highlight anchor missing')
s=s.replace(anchor,insert+anchor,1)
p.write_text(s,encoding='utf-8')
print('render segment pairs added')

p=Path('index.html');s=p.read_text(encoding='utf-8')
old='''    const original=await extractPageText(targetPage);\n    if(loadToken!==pageLoadToken || targetPage!==page) return;\n    currentSourceSentences=splitSourceSentences(original);\n    refreshSourceRanges();\n    renderSentences(translated||'Nenhum texto reconhecido nesta página.');\n'''
new='''    const original=await extractPageText(targetPage);\n    if(loadToken!==pageLoadToken || targetPage!==page) return;\n    const record=pageAlignmentCache.get(targetPage);\n    if(record?.segments?.length) renderSegmentPairs(record.segments);\n    else{currentSegments=[];currentSourceSentences=splitSourceSentences(original);refreshSourceRanges();renderSentences(translated||'Nenhum texto reconhecido nesta página.');}\n'''
if old not in s: raise SystemExit('loadPage source/render block missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('loadPage exact alignment patched')
