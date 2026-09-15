from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2-mobile.mjs')
s=p.read_text(encoding='utf-8-sig')
old="function buildSourceItemRanges(segments,items){const flat=[];items.forEach((it,itemIndex)=>normTokens(it.str).forEach(token=>flat.push({token,itemIndex})));const ranges=[];let cursor=0;for(const seg of segments){const wanted=normTokens(seg.source);if(!wanted.length){ranges.push([]);continue;}let best=-1;for(let i=cursor;i<flat.length;i++){if(flat[i].token!==wanted[0])continue;let ok=0,j=i;while(j<flat.length&&ok<wanted.length){if(flat[j].token===wanted[ok])ok++;j++;}if(ok>=Math.min(wanted.length,Math.max(3,Math.floor(wanted.length*.7)))){best=i;break;}}if(best<0){ranges.push([]);continue;}let j=best,ok=0,last=best;while(j<flat.length&&ok<wanted.length){if(flat[j].token===wanted[ok]){ok++;last=j;}j++;}ranges.push([...new Set(flat.slice(best,last+1).map(x=>x.itemIndex))]);cursor=last+1;}return ranges;}"
new="""function buildSourceItemRanges(segments,items){
  const flat=[];items.forEach((it,itemIndex)=>normTokens(it.str).forEach(token=>flat.push({token,itemIndex})));
  const ranges=[];let cursor=0;
  for(const seg of segments){
    const wanted=normTokens(seg.source);if(!wanted.length){ranges.push([]);continue;}
    let best=null;const maxStart=Math.max(cursor,flat.length-1);
    for(let i=cursor;i<=maxStart;i++){
      let wi=0,j=i,matches=0,gaps=0,last=i;
      while(j<flat.length&&wi<wanted.length&&gaps<=Math.max(3,Math.ceil(wanted.length*.18))){
        if(flat[j].token===wanted[wi]){matches++;wi++;last=j;}else gaps++;j++;
      }
      const coverage=matches/Math.max(1,wanted.length),span=Math.max(1,last-i+1),density=matches/span;
      const score=coverage*.78+density*.22;
      if((!best||score>best.score)&&coverage>=.82&&density>=.58)best={i,last,score,coverage};
      if(best?.coverage===1&&best.score>.94)break;
    }
    if(!best){ranges.push([]);continue;}
    ranges.push([...new Set(flat.slice(best.i,best.last+1).map(x=>x.itemIndex))]);cursor=best.last+1;
  }
  return ranges;
}"""
assert old in s, 'old matcher not found'
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('MATCHER_PATCHED')
s=p.read_text(encoding='utf-8')
old="for(const b of lines){const el=document.createElement('div');el.className='pdfSourceMark';Object.assign(el.style,{left:`${b.x}px`,top:`${b.y+b.h*.82}px`,width:`${b.w}px`,height:`2px`});layer.appendChild(el);}"
new="""for(const b of lines){
  const el=document.createElement('div');el.className='pdfSourceMark';
  const padX=Math.max(1,Math.min(3,b.h*.12)),padY=Math.max(1,Math.min(2,b.h*.08));
  Object.assign(el.style,{left:`${b.x-padX}px`,top:`${b.y-padY}px`,width:`${b.w+padX*2}px`,height:`${b.h+padY*2}px`});
  layer.appendChild(el);
}"""
assert old in s, 'underline renderer not found'
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('RENDERER_PATCHED')
idx=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
h=idx.read_text(encoding='utf-8-sig')
import re
h,n=re.subn(r'\.pdfSourceMark\{[^}]*\}', '.pdfSourceMark{position:absolute;background:rgba(139,92,246,.22);border:0!important;border-radius:3px;box-shadow:none!important;pointer-events:none;mix-blend-mode:multiply}', h, count=1)
assert n==1, f'css replacements={n}'
idx.write_text(h,encoding='utf-8')
print('CSS_PATCHED')
sw=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\sw.js')
w=sw.read_text(encoding='utf-8-sig').replace("readerpro-shell-v7","readerpro-shell-v8")
sw.write_text(w,encoding='utf-8')
print('CACHE_V8')