from pathlib import Path
p=Path('index.html');s=p.read_text(encoding='utf-8')
start=s.index('async function warmNextPages(fromPage,count=10){')
end=s.index('\nfunction refreshSourceRanges',start)
new=r'''function voiceNeedsPriority(){
  if(!speaking||$('voice').value==='system:browser')return false;
  const tail=audioTimeline[audioTimeline.length-1];
  const ahead=tail?tail.idx-sentenceIndex:0;
  return audioFillRunning||audioPending.size>0||ahead<3;
}
async function waitForBackgroundSlot(generation){
  while(generation===preloadGeneration&&voiceNeedsPriority())await new Promise(r=>setTimeout(r,320));
}
async function warmNextPages(fromPage,count=10){
  const generation=++preloadGeneration,targets=[];
  for(let n=fromPage+1;n<=Math.min(pdf.numPages,fromPage+count);n++)if(!translationCache.has(n))targets.push(n);
  if(!targets.length){if(!speaking)setBuffer(`próximas ${Math.min(count,pdf.numPages-fromPage)} prontas`,true);return;}
  let ready=0;if(!speaking)setBuffer(`buffer 0/${targets.length} páginas`);
  for(const n of targets){
    if(generation!==preloadGeneration)return;
    await waitForBackgroundSlot(generation);if(generation!==preloadGeneration)return;
    try{await translatePage(n,{foreground:false});ready++;}catch{}
    if(generation!==preloadGeneration)return;
    if(!speaking)setBuffer(`buffer ${ready}/${targets.length} páginas`,ready===targets.length);
    await new Promise(r=>setTimeout(r,speaking?950:140));
  }
}
'''
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('dynamic CPU priority patched')
