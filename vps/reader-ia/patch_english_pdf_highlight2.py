from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
needle="function renderSentences(text){"
insert=r'''function splitSourceSentences(text){
  const normalized=String(text||'').replace(/\s*\n+\s*/g,' ').replace(/\s+/g,' ').trim();
  if(!normalized) return [];
  if(typeof Intl!=='undefined' && Intl.Segmenter){
    const seg=new Intl.Segmenter('en-US',{granularity:'sentence'});
    return [...seg.segment(normalized)].map(x=>x.segment.trim()).filter(Boolean);
  }
  return (normalized.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g)||[normalized]).map(x=>x.trim()).filter(Boolean);
}
function normTokens(text){
  return String(text||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]+(?:['’][a-z0-9]+)?/g)||[];
}
function buildSourceItemRanges(sentences,items){
  const flat=[];
  items.forEach((it,itemIndex)=>normTokens(it.str).forEach(token=>flat.push({token,itemIndex})));
  const ranges=[];let cursor=0;
  for(const sentence of sentences){
    const wanted=normTokens(sentence);if(!wanted.length){ranges.push([]);continue;}
    let best=-1;
    for(let i=cursor;i<flat.length;i++){
      if(flat[i].token!==wanted[0])continue;
      let ok=0,j=i;
      while(j<flat.length&&ok<wanted.length){if(flat[j].token===wanted[ok])ok++;j++;}
      if(ok>=Math.min(wanted.length,Math.max(3,Math.floor(wanted.length*.72)))){best=i;break;}
    }
    if(best<0){ranges.push([]);continue;}
    let j=best,ok=0,last=best;
    while(j<flat.length&&ok<wanted.length){if(flat[j].token===wanted[ok]){ok++;last=j;}j++;}
    const ids=[...new Set(flat.slice(best,last+1).map(x=>x.itemIndex))];ranges.push(ids);cursor=last+1;
  }
  return ranges;
}
'''
if needle not in s: raise SystemExit('needle missing')
s=s.replace(needle,insert+needle,1)
p.write_text(s,encoding='utf-8')
print('source helpers patched')