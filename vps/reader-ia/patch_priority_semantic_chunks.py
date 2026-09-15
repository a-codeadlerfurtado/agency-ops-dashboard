from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="""function splitSentences(text){
  const units=[];
  for(const raw of String(text||'').split(/\\n+/)){
    const line=raw.replace(/\\s+/g,' ').trim();
    if(!line) continue;
    if(line.length<=95 && !/[.!?…:]$/.test(line)){units.push(line);continue;}
    const parts=line.match(/[^.!?…]+(?:[.!?…]+(?=\\s|$)|$)/g)||[line];
    for(const part of parts){const clean=part.trim();if(clean) units.push(clean);}
  }
  return units;
}
"""
new="""function splitSentences(text){
  const out=[];
  const segmenter=typeof Intl!=='undefined'&&Intl.Segmenter
    ? new Intl.Segmenter('pt-BR',{granularity:'sentence'}) : null;
  for(const raw of String(text||'').split(/\\n+/)){
    const paragraph=raw.replace(/\\s+/g,' ').trim();
    if(!paragraph) continue;
    const looksLikeTitle=paragraph.length<=110 && !/[.!?…]$/.test(paragraph);
    if(looksLikeTitle){out.push(paragraph);continue;}
    let sentences=segmenter
      ? [...segmenter.segment(paragraph)].map(x=>x.segment.trim()).filter(Boolean)
      : (paragraph.match(/[^.!?…]+(?:[.!?…]+(?=\\s|$)|$)/g)||[paragraph]).map(x=>x.trim()).filter(Boolean);
    let chunk='';
    for(const sentence of sentences){
      if(!chunk){chunk=sentence;continue;}
      const joinRequired=/[:;–—-]$/.test(chunk) || /^(?:e|mas|porém|porque|pois|portanto|assim|além disso|ou seja|quando|enquanto|embora|como|que)\\b/i.test(sentence);
      const candidate=chunk+' '+sentence;
      if(joinRequired || candidate.length<=330){chunk=candidate;}
      else {out.push(chunk);chunk=sentence;}
    }
    if(chunk) out.push(chunk);
  }
  return out;
}
"""
if old not in s: raise SystemExit('splitSentences block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('semantic narration chunks patched')