from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
start=s.index('function splitSentences(text){')
end=s.index('\nfunction renderSentences(text){',start)
new="""function splitSentences(text){
  const units=[];
  const segmenter=typeof Intl!=='undefined'&&Intl.Segmenter
    ? new Intl.Segmenter('pt-BR',{granularity:'sentence'}) : null;
  for(const raw of String(text||'').split(/\\n+/)){
    const paragraph=raw.replace(/\\s+/g,' ').trim();
    if(!paragraph) continue;
    const heading=paragraph.length<=110 && !/[.!?…]$/.test(paragraph);
    if(heading){units.push(paragraph);continue;}
    const sentences=segmenter
      ? [...segmenter.segment(paragraph)].map(x=>x.segment.trim()).filter(Boolean)
      : (paragraph.match(/[^.!?…]+(?:[.!?…]+(?=\\s|$)|$)/g)||[paragraph]).map(x=>x.trim()).filter(Boolean);
    for(const sentence of sentences){
      if(sentence.length<=3600){units.push(sentence);continue;}
      const safe=sentence.match(/.{1,3200}(?:[;:]\\s+|$)/g)?.map(x=>x.trim()).filter(Boolean);
      if(safe?.length>1) units.push(...safe); else units.push(sentence);
    }
  }
  return units;
}
"""
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('exact sentence narration units patched')