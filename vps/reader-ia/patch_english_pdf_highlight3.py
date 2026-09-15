from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
needle="function cleanPdfText(text){"
insert=r'''function sourceIndexForNarration(idx){
  if(!currentSourceSentences.length||!currentSentences.length)return -1;
  if(currentSourceSentences.length===currentSentences.length)return Math.min(idx,currentSourceSentences.length-1);
  const totalPt=currentSentences.reduce((a,x)=>a+x.length,0)||1;
  const before=currentSentences.slice(0,idx).reduce((a,x)=>a+x.length,0);
  const ratio=before/totalPt;
  const target=ratio*(currentSourceSentences.reduce((a,x)=>a+x.length,0)||1);
  let acc=0;
  for(let i=0;i<currentSourceSentences.length;i++){acc+=currentSourceSentences[i].length;if(acc>=target)return i;}
  return currentSourceSentences.length-1;
}
function updatePdfSourceHighlight(){
  const layer=document.getElementById('pdfHighlightLayer');
  if(!layer)return;
  layer.innerHTML='';
  if(!speaking||sentenceIndex<0)return;
  const sourceIdx=sourceIndexForNarration(sentenceIndex);
  const ids=sourceSentenceRanges[sourceIdx]||[];
  if(!ids.length)return;
  const boxes=ids.map(i=>pdfTextGeometry[i]).filter(Boolean);
  if(!boxes.length)return;
  const lines=[];
  for(const b of boxes){
    let line=lines.find(x=>Math.abs(x.y-b.y)<Math.max(3,Math.min(x.h,b.h)*.58));
    if(!line){line={x:b.x,y:b.y,w:b.w,h:b.h,right:b.x+b.w};lines.push(line);}
    else{line.x=Math.min(line.x,b.x);line.y=Math.min(line.y,b.y);line.right=Math.max(line.right,b.x+b.w);line.h=Math.max(line.h,b.h);line.w=line.right-line.x;}
  }
  lines.forEach(b=>{const el=document.createElement('div');el.className='pdfSourceMark';el.style.left=(b.x-2)+'px';el.style.top=(b.y-1)+'px';el.style.width=(b.w+4)+'px';el.style.height=(b.h+3)+'px';layer.appendChild(el);});
  const pane=document.querySelector('.pdfPane'),wrap=document.querySelector('.pdfWrap');
  const minY=Math.min(...lines.map(x=>x.y)),maxY=Math.max(...lines.map(x=>x.y+x.h));
  const top=wrap.offsetTop+minY,bottom=wrap.offsetTop+maxY;
  if(top<pane.scrollTop+55||bottom>pane.scrollTop+pane.clientHeight-55)pane.scrollTop=Math.max(0,top-pane.clientHeight*.28);
}
'''
if needle not in s: raise SystemExit('needle missing')
s=s.replace(needle,insert+needle,1)
s=s.replace("$('progressText').textContent=currentSentences.length?`Frase ${Math.min(sentenceIndex+1,currentSentences.length)} de ${currentSentences.length} • página ${page}`:`Página ${page}`;", "$('progressText').textContent=currentSentences.length?`Frase ${Math.min(sentenceIndex+1,currentSentences.length)} de ${currentSentences.length} • página ${page}`:`Página ${page}`;\n  updatePdfSourceHighlight();",1)
p.write_text(s,encoding='utf-8')
print('highlight mapping patched')