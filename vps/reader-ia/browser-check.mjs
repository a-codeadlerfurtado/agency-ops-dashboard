
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const $=id=>document.getElementById(id);
const BASE='/reader';
let pdf=null,page=1,fileMeta=null,renderToken=0,pageLoadToken=0,preloadGeneration=0;
let speaking=false,paused=false,sentenceIndex=0,currentSentences=[],currentSourceSentences=[],sourceSentenceRanges=[],pdfTextGeometry=[],pendingSentenceIndex=null,pendingVoice=null;
let currentAudio=null,currentAudioUrl=null,audioRequestToken=0;
let audioContext=null,currentSource=null,currentBuffer=null;
let audioTimeline=[],audioScheduleGeneration=0,audioFillRunning=false,highlightRaf=0;
const audioCache=new Map(),audioPending=new Map(),decodedAudioCache=new Map();
const pageTextCache=new Map(),translationCache=new Map(),translationPending=new Map(),pdfTextContentCache=new Map();

function setStatus(text){$('status').textContent=text;}
function setBuffer(text,ready=false){
  $('bufferBadge').textContent=text;
  $('bufferBadge').style.color=ready?'#7ee2b8':'#9ba7bd';
}
function bookKey(){return fileMeta?`reader:${fileMeta.name}:${fileMeta.size}`:null;}
function saveProgress(){
  if(!bookKey()) return;
  localStorage.setItem(bookKey(),JSON.stringify({page,sentenceIndex,rate:$('rate').value,voice:$('voice').value}));
}
function restoreProgress(){
  if(!bookKey()) return;
  try{
    const p=JSON.parse(localStorage.getItem(bookKey())||'{}');
    if(p.page) page=Math.min(Math.max(1,p.page),pdf.numPages);
    if(Number.isInteger(p.sentenceIndex)) pendingSentenceIndex=p.sentenceIndex;
    if(p.rate) $('rate').value=p.rate;
    if(p.voice) pendingVoice=p.voice;
  }catch{}
}
function splitSentences(text){
  // Narração: uma unidade completa entre pontuações finais.
  // Quebras de linha do PDF nunca cortam a frase.
  const normalized=String(text||'')
    .replace(/\s*\n+\s*/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  if(!normalized) return [];
  if(typeof Intl!=='undefined' && Intl.Segmenter){
    const seg=new Intl.Segmenter('pt-BR',{granularity:'sentence'});
    return [...seg.segment(normalized)]
      .map(x=>x.segment.trim()).filter(Boolean);
  }
  return (normalized.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g)||[normalized])
    .map(x=>x.trim()).filter(Boolean);
}

function splitSourceSentences(text){
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
function renderSentences(text){
  currentSentences=splitSentences(text);
  sentenceIndex=pendingSentenceIndex===null?0:Math.min(Math.max(0,pendingSentenceIndex),Math.max(0,currentSentences.length-1));
  pendingSentenceIndex=null;
  const host=$('translation');
  host.innerHTML='';
  currentSentences.forEach((s,i)=>{
    const span=document.createElement('span');
    span.className='sentence';
    span.dataset.index=i;
    span.textContent=s+' ';
    span.addEventListener('click',()=>{stopSpeech();sentenceIndex=i;startSpeech();});
    host.appendChild(span);
  });
  updateSentenceHighlight();
}
function updateSentenceHighlight(){
  document.querySelectorAll('.sentence').forEach((el,i)=>{
    el.classList.toggle('active',i===sentenceIndex && speaking);
    el.classList.toggle('done',i<sentenceIndex);
  });
  const active=document.querySelector('.sentence.active');
  if(active){
    const pane=$('translation'),r=active.getBoundingClientRect(),pr=pane.getBoundingClientRect();
    if(r.top<pr.top+36||r.bottom>pr.bottom-72) active.scrollIntoView({behavior:'auto',block:'center'});
  }
  const pct=currentSentences.length?Math.min(100,(sentenceIndex/currentSentences.length)*100):0;
  $('progressBar').style.width=pct+'%';
  $('progressText').textContent=currentSentences.length?`Frase ${Math.min(sentenceIndex+1,currentSentences.length)} de ${currentSentences.length} • página ${page}`:`Página ${page}`;
  updatePdfSourceHighlight();
}
function sourceIndexForNarration(idx){
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
function cleanPdfText(text){
  let t=(text||'').replace(/([A-Za-zÀ-ÿ])-\n(?=[A-Za-zÀ-ÿ])/g,'$1');
  const lines=t.split(/\n+/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const kept=lines.filter(line=>{
    if(/^(?:page|página)?\s*\d+(?:\s*(?:of|de)\s*\d+)?$/i.test(line)) return false;
    if(/^(?:https?:\/\/|www\.|file:\/\/)/i.test(line)) return false;
    if(/(?:https?:\/\/|www\.|file:\/\/)/i.test(line) && line.length<180) return false;
    if(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}(?:[, ]+\d{1,2}:\d{2})?$/i.test(line)) return false;
    if(/^[-–—•|_\s\d]+$/.test(line) && line.length<20) return false;
    return true;
  });
  return kept.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
async function extractPageText(n){
  if(pageTextCache.has(n)) return pageTextCache.get(n);
  const p=await pdf.getPage(n);
  const content=pdfTextContentCache.get(n)||await p.getTextContent();
  pdfTextContentCache.set(n,content);
  let out='',lastY=null;
  for(const item of content.items){
    const y=item.transform?.[5];
    if(lastY!==null && Math.abs(y-lastY)>6) out+='\n';
    else if(out && !out.endsWith('\n')) out+=' ';
    out+=item.str;
    lastY=y;
  }
  out=cleanPdfText(out.replace(/\s+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim());
  pageTextCache.set(n,out);
  return out;
}
async function translatePage(n,{foreground=true}={}){
  if(translationCache.has(n)) return translationCache.get(n);
  if(translationPending.has(n)) return translationPending.get(n);
  const job=(async()=>{
    const original=await extractPageText(n);
    if(!original){translationCache.set(n,'');return '';}
    let context='';
    if(n>1){try{context=(await extractPageText(n-1)).slice(-2200);}catch{}}
    async function callTranslate(mode,timeoutMs){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const res=await fetch(BASE+'/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({text:original,context,source:'en',target:'pt',mode})});
        const data=await res.json();
        if(!res.ok) throw new Error(data.detail||data.error||'Falha na tradução');
        return data.translatedText||'';
      }finally{clearTimeout(timer);}
    }
    let translated='';
    try{translated=await callTranslate('editorial',foreground?12000:20000);}
    catch(err){if(foreground)setStatus(`Página ${n}: usando tradução rápida...`);translated=await callTranslate('literal',18000);}
    translated=(translated||'').replace(/\*\*/g,'').replace(/^#{1,6}\s*/gm,'').replace(/`/g,'').trim();
    translationCache.set(n,translated);return translated;
  })();
  translationPending.set(n,job);
  try{return await job;}finally{translationPending.delete(n);}
}

async function warmNextPages(fromPage,count=10){
  const generation=++preloadGeneration;
  const targets=[];
  for(let n=fromPage+1;n<=Math.min(pdf.numPages,fromPage+count);n++) if(!translationCache.has(n)) targets.push(n);
  if(!targets.length){setBuffer(`próximas ${Math.min(count,pdf.numPages-fromPage)} prontas`,true);return;}
  let ready=0;setBuffer(`buffer 0/${targets.length} páginas`);
  for(const n of targets){
    if(generation!==preloadGeneration) return;
    try{await translatePage(n,{foreground:false});ready++;}catch{}
    if(generation!==preloadGeneration) return;
    setBuffer(`buffer ${ready}/${targets.length} páginas`,ready===targets.length);
    await new Promise(r=>setTimeout(r,speaking?700:120));
  }
}
function refreshSourceRanges(){
  const content=pdfTextContentCache.get(page);
  sourceSentenceRanges=content?buildSourceItemRanges(currentSourceSentences,content.items):[];
  updatePdfSourceHighlight();
}
async function renderPdfPage(n){
  const token=++renderToken;
  $('pdfLoading').classList.add('show');
  const pdfPage=await pdf.getPage(n);
  const content=pdfTextContentCache.get(n)||await pdfPage.getTextContent();
  pdfTextContentCache.set(n,content);
  const viewport0=pdfPage.getViewport({scale:1});
  const pdfPane=document.querySelector('.pdfPane');
  const maxW=Math.max(420,(pdfPane?.clientWidth||900)-44);
  const scale=Math.min(2.2,maxW/viewport0.width);
  const viewport=pdfPage.getViewport({scale});
  const ratio=Math.min(window.devicePixelRatio||1,2);
  const fresh=document.createElement('canvas');
  fresh.width=Math.ceil(viewport.width*ratio);
  fresh.height=Math.ceil(viewport.height*ratio);
  fresh.style.width=viewport.width+'px';
  fresh.style.height=viewport.height+'px';
  fresh.setAttribute('aria-label',`Página ${n} do PDF`);
  const ctx=fresh.getContext('2d',{alpha:false});
  ctx.setTransform(ratio,0,0,ratio,0,0);
  await pdfPage.render({canvasContext:ctx,viewport}).promise;
  if(token!==renderToken) return;
  const wrap=document.querySelector('.pdfWrap');
  const oldCanvas=wrap.querySelector('canvas');
  fresh.id='canvas';
  if(oldCanvas) oldCanvas.replaceWith(fresh); else wrap.appendChild(fresh);
  let layer=wrap.querySelector('#pdfHighlightLayer');
  if(!layer){layer=document.createElement('div');layer.id='pdfHighlightLayer';layer.className='pdfHighlightLayer';wrap.appendChild(layer);}
  layer.style.width=viewport.width+'px';layer.style.height=viewport.height+'px';
  pdfTextGeometry=content.items.map(item=>{
    const tx=pdfjsLib.Util.transform(viewport.transform,item.transform);
    const h=Math.max(5,Math.hypot(tx[2],tx[3]));
    return {x:tx[4],y:tx[5]-h,w:Math.max(2,(item.width||0)*viewport.scale),h};
  });
  if(n===page)refreshSourceRanges();
  $('pdfLoading').classList.remove('show');
}

async function loadPage(n,{autoplay=false}={}){
  if(!pdf) return;
  const loadToken=++pageLoadToken;
  preloadGeneration++;
  stopSpeech();
  currentSentences=[];currentSourceSentences=[];sourceSentenceRanges=[];pdfTextGeometry=[];sentenceIndex=0;pendingSentenceIndex=null;updateSentenceHighlight();
  page=Math.min(Math.max(1,n),pdf.numPages);
  $('pageNum').value=page;$('pageTotal').textContent=`/ ${pdf.numPages}`;
  setStatus(`Página ${page}: preparando tradução em português...`);
  renderPdfPage(page).catch(err=>{
    $('pdfLoading').classList.remove('show');
    console.error('pdf_render_failed',err);
  });
  try{
    const targetPage=page;
    setBuffer('prioridade: página atual');
    const translated=await translatePage(targetPage,{foreground:true});
    if(loadToken!==pageLoadToken || targetPage!==page) return;
    const original=await extractPageText(targetPage);
    if(loadToken!==pageLoadToken || targetPage!==page) return;
    currentSourceSentences=splitSourceSentences(original);
    refreshSourceRanges();
    renderSentences(translated||'Nenhum texto reconhecido nesta página.');
    setStatus(`Página ${page} pronta • tradução editorial contextualizada`);
    setBuffer('página atual pronta • preparando próximas 10',true);
    saveProgress();
    if(autoplay && translated && loadToken===pageLoadToken) startSpeech();
    if(loadToken===pageLoadToken) setTimeout(()=>warmNextPages(targetPage,10),80);
  }catch(err){
    if(loadToken!==pageLoadToken) return;
    stopSpeech();currentSentences=[];sentenceIndex=0;updateSentenceHighlight();
    $('translation').innerHTML='<div class="empty">Não consegui traduzir esta página.<br><br><button class="btn" id="retryTranslation">Tentar novamente</button></div>';
    setStatus(`Falha na tradução: ${String(err.message||err)}`);
    setBuffer('tradução indisponível');
    $('retryTranslation')?.addEventListener('click',()=>{translationCache.delete(page);loadPage(page);});
  }
}
function ensureAudioContext(){
  if(!audioContext) audioContext=new (window.AudioContext||window.webkitAudioContext)();
  if(audioContext.state==='suspended') return audioContext.resume();
  return Promise.resolve();
}
function cleanupAudio(){
  clearScheduledAudio();
  if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}
  if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}
}
function stopSpeech(){
  audioRequestToken++;cleanupAudio();speechSynthesis.cancel();
  speaking=false;paused=false;
  $('play').textContent='▶ Ouvir';$('play').classList.remove('playing');
  updateSentenceHighlight();
}
const voiceGroups={p:'🇧🇷 Português (recomendadas)',a:'🇺🇸 Inglês americano',b:'🇬🇧 Inglês britânico',e:'🇪🇸 Espanhol',f:'🇫🇷 Francês',h:'🇮🇳 Hindi',i:'🇮🇹 Italiano',j:'🇯🇵 Japonês',z:'🇨🇳 Mandarim'};
async function populateVoices(){
  const select=$('voice');
  select.innerHTML='<option>Carregando vozes locais...</option>';
  try{
    const res=await fetch(BASE+'/api/voices');
    const data=await res.json();
    if(!res.ok) throw new Error(data.detail||data.error||'TTS indisponível');
    const list=Array.isArray(data.voices)?data.voices:[];
    select.innerHTML='';
    const byGroup={};
    list.forEach(v=>{const g=(v.id||'a')[0];(byGroup[g]??=[]).push(v);});
    ['p','a','b','e','f','h','i','j','z'].forEach(g=>{
      if(!byGroup[g]?.length)return;
      const og=document.createElement('optgroup');og.label=voiceGroups[g]||g;
      byGroup[g].forEach(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=`${v.id} — ${v.description||''}`;og.appendChild(o);});
      select.appendChild(og);
    });
    const og=document.createElement('optgroup');og.label='💻 Voz do navegador (fallback)';
    const o=document.createElement('option');o.value='system:browser';o.textContent='Voz padrão do Windows/Chrome';og.appendChild(o);select.appendChild(og);
    const desired=pendingVoice||localStorage.getItem('reader:lastVoice')||'pm_jarvis';
    if([...select.options].some(x=>x.value===desired)) select.value=desired;
    pendingVoice=null;
  }catch(err){
    select.innerHTML='<option value="system:browser">Voz do navegador (Kokoro iniciando...)</option>';
    setStatus(`Voz local iniciando: ${err.message||err}`);
  }
}
populateVoices();

async function getLocalAudio(text){
  const voice=$('voice').value;
  const speed=1; // cache canonical audio once; playback speed is client-side
  const key=`${voice}|${text}`;
  if(audioCache.has(key)) return audioCache.get(key);
  if(audioPending.has(key)) return audioPending.get(key);
  const pending=(async()=>{
    const res=await fetch(BASE+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice,speed})});
    if(!res.ok){let d={};try{d=await res.json()}catch{};throw new Error(d.detail||d.error||`TTS ${res.status}`);}
    const blob=await res.blob();
    audioCache.set(key,blob);
    if(audioCache.size>80) audioCache.delete(audioCache.keys().next().value);
    return blob;
  })();
  audioPending.set(key,pending);
  try{return await pending;}finally{audioPending.delete(key);}
}

function trimAudioBuffer(buffer){
  const threshold=0.0035,rate=buffer.sampleRate,total=buffer.length;
  let first=0,last=total-1,found=false;
  for(let i=0;i<total&&!found;i++)for(let c=0;c<buffer.numberOfChannels;c++)if(Math.abs(buffer.getChannelData(c)[i])>threshold){first=i;found=true;break;}
  found=false;for(let i=total-1;i>=0&&!found;i--)for(let c=0;c<buffer.numberOfChannels;c++)if(Math.abs(buffer.getChannelData(c)[i])>threshold){last=i;found=true;break;}
  first=Math.max(0,first-Math.floor(rate*0.018));last=Math.min(total-1,last+Math.floor(rate*0.045));
  if(last<=first||last-first>total*0.98)return buffer;
  const out=audioContext.createBuffer(buffer.numberOfChannels,last-first+1,rate);
  for(let c=0;c<buffer.numberOfChannels;c++)out.copyToChannel(buffer.getChannelData(c).subarray(first,last+1),c);
  return out;
}
function narrationGap(text){return /[!?]$/.test(text)?0.13:/[.…]$/.test(text)?0.085:0.035;}
async function getDecodedAudio(text){
  const voice=$('voice').value;
  const key=`${voice}|${text}`;
  if(decodedAudioCache.has(key)) return decodedAudioCache.get(key);
  const blob=await getLocalAudio(text);
  await ensureAudioContext();
  const bytes=await blob.arrayBuffer();
  const buffer=trimAudioBuffer(await audioContext.decodeAudioData(bytes.slice(0)));
  decodedAudioCache.set(key,buffer);
  if(decodedAudioCache.size>60) decodedAudioCache.delete(decodedAudioCache.keys().next().value);
  return buffer;
}
function clearScheduledAudio(){
  audioScheduleGeneration++;
  audioFillRunning=false;
  if(highlightRaf){cancelAnimationFrame(highlightRaf);highlightRaf=0;}
  for(const e of audioTimeline){
    try{e.source.onended=null;e.source.stop();e.source.disconnect();}catch{}
  }
  audioTimeline=[];currentSource=null;currentBuffer=null;
}
function scheduleHighlightLoop(generation){
  if(highlightRaf) cancelAnimationFrame(highlightRaf);
  const tick=()=>{
    if(generation!==audioScheduleGeneration||!speaking)return;
    if(!paused&&audioContext){
      const now=audioContext.currentTime;
      const active=audioTimeline.find(e=>now>=e.start-0.015&&now<e.end-0.01);
      if(active&&active.idx!==sentenceIndex){sentenceIndex=active.idx;saveProgress();updateSentenceHighlight();}
      const tail=audioTimeline[audioTimeline.length-1];
      if(tail&&tail.idx-sentenceIndex<=2) fillAudioSchedule(generation);
    }
    highlightRaf=requestAnimationFrame(tick);
  };
  highlightRaf=requestAnimationFrame(tick);
}async function fillAudioSchedule(generation=audioScheduleGeneration){
  if(audioFillRunning||generation!==audioScheduleGeneration||!speaking||paused)return;
  audioFillRunning=true;
  try{
    while(generation===audioScheduleGeneration&&speaking&&!paused){
      const last=audioTimeline[audioTimeline.length-1];
      const nextIdx=last?last.idx+1:sentenceIndex;
      if(nextIdx>=currentSentences.length)break;
      if(last&&last.idx-sentenceIndex>=4)break;
      const buffer=await getDecodedAudio(currentSentences[nextIdx]);
      if(generation!==audioScheduleGeneration||!speaking||paused)return;
      const rate=Number($('rate').value)||1;
      let startAt=last?(last.end+narrationGap(currentSentences[last.idx])):audioContext.currentTime+0.06;
      if(startAt<audioContext.currentTime+0.02)startAt=audioContext.currentTime+0.02;
      const source=audioContext.createBufferSource();
      source.buffer=buffer;source.playbackRate.value=rate;source.connect(audioContext.destination);
      const entry={idx:nextIdx,source,start:startAt,end:startAt+(buffer.duration/rate),rate};
      source.onended=()=>{
        if(generation!==audioScheduleGeneration||!speaking)return;
        if(nextIdx===currentSentences.length-1){
          if(page<pdf.numPages)loadPage(page+1,{autoplay:true});
          else{stopSpeech();$('progressBar').style.width='100%';$('progressText').textContent='Fim do documento';}
        }else if(!paused)fillAudioSchedule(generation);
      };
      source.start(startAt);audioTimeline.push(entry);
      if(nextIdx===sentenceIndex){currentSource=source;currentBuffer=buffer;}
      setBuffer(`voz local • fluxo contínuo ${Math.min(5,audioTimeline.length)} frases`,true);
    }
  }catch(err){
    if(generation===audioScheduleGeneration){setStatus(`Voz local: ${err.message||err}`);stopSpeech();}
  }finally{if(generation===audioScheduleGeneration)audioFillRunning=false;}
}function advanceSentence(){
  if(!speaking)return;
  sentenceIndex++;saveProgress();updateSentenceHighlight();speakCurrentSentence();
}
function speakBrowserSentence(){
  const utter=new SpeechSynthesisUtterance(currentSentences[sentenceIndex]);
  utter.lang='pt-BR';utter.rate=Number($('rate').value)||1;
  const voices=speechSynthesis.getVoices();utter.voice=voices.find(v=>/^pt-BR/i.test(v.lang))||voices.find(v=>/^pt/i.test(v.lang))||voices[0];
  utter.onstart=updateSentenceHighlight;utter.onend=advanceSentence;
  utter.onerror=e=>{if(!['canceled','interrupted'].includes(e.error)){setStatus(`Voz interrompida: ${e.error}`);stopSpeech();}};
  speechSynthesis.speak(utter);
}
async function startLocalContinuous(){
  if(!speaking||paused)return;
  await ensureAudioContext();
  const generation=audioScheduleGeneration;
  setBuffer('preparando fluxo contínuo');
  fillAudioSchedule(generation);
  scheduleHighlightLoop(generation);
}
async function speakCurrentSentence(){
  if(!speaking)return;
  if(sentenceIndex>=currentSentences.length){
    if(page<pdf.numPages)return loadPage(page+1,{autoplay:true});
    stopSpeech();$('progressBar').style.width='100%';$('progressText').textContent='Fim do documento';return;
  }
  if($('voice').value==='system:browser')return speakBrowserSentence();
  return startLocalContinuous();
}
function startSpeech(){
  if(!currentSentences.length)return;
  speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateSentenceHighlight();speakCurrentSentence();
}
function toggleSpeech(){
  if(!speaking){
    if($('voice').value!=='system:browser') ensureAudioContext();
    startSpeech();return;
  }
  if(!paused){
    paused=true;
    if($('voice').value==='system:browser') speechSynthesis.pause();
    else if(audioContext?.state==='running') audioContext.suspend();
    $('play').textContent='▶ Continuar';
  }else{
    paused=false;$('play').textContent='⏸ Pausar';
    if($('voice').value==='system:browser') speechSynthesis.resume();
    else if(currentSource) ensureAudioContext(); else {ensureAudioContext();speakCurrentSentence();}
  }
}

$('play').addEventListener('click',toggleSpeech);
$('prev').addEventListener('click',()=>loadPage(page-1));
$('next').addEventListener('click',()=>loadPage(page+1));
$('pageNum').addEventListener('change',()=>loadPage(Number($('pageNum').value)||1));
$('rate').addEventListener('change',()=>{
  saveProgress();
  const rate=Number($('rate').value)||1;
  if(!speaking) return;
  if($('voice').value==='system:browser'){
    // SpeechSynthesis cannot change an utterance rate in-place; restart only this sentence.
    const wasPaused=paused;speechSynthesis.cancel();
    if(!wasPaused){paused=false;setTimeout(()=>speakBrowserSentence(),40);}
    return;
  }
  // Rebuild the already-decoded local schedule so sentence boundaries stay sample-accurate.
  const wasPaused=paused;
  clearScheduledAudio();
  setBuffer(`voz local • ${rate}x`,true);
  if(!wasPaused){paused=false;startLocalContinuous();}
});
$('voice').addEventListener('change',()=>{
  localStorage.setItem('reader:lastVoice',$('voice').value);saveProgress();
  if(speaking){const wasPaused=paused;audioRequestToken++;cleanupAudio();speechSynthesis.cancel();if(!wasPaused){paused=false;setTimeout(()=>speakCurrentSentence(),60);}}
});

$('file').addEventListener('change',async e=>{
  const f=e.target.files?.[0];if(!f)return;
  stopSpeech();pageTextCache.clear();translationCache.clear();pdfTextContentCache.clear();currentSourceSentences=[];sourceSentenceRanges=[];pdfTextGeometry=[];
  fileMeta={name:f.name,size:f.size,lastModified:f.lastModified};
  $('docTitle').textContent=f.name.replace(/\.pdf$/i,'');
  setStatus('Abrindo PDF...');
  const bytes=new Uint8Array(await f.arrayBuffer());
  pdf=await pdfjsLib.getDocument({data:bytes}).promise;
  page=1;pendingSentenceIndex=null;
  restoreProgress();
  if(pendingVoice && [...$('voice').options].some(o=>o.value===pendingVoice)){$('voice').value=pendingVoice;pendingVoice=null;}
  $('pageTotal').textContent=`/ ${pdf.numPages}`;
  await loadPage(page);
});

window.addEventListener('keydown',e=>{
  if(e.code==='Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)){
    e.preventDefault();toggleSpeech();
  }
  if(e.code==='ArrowRight' && e.altKey){e.preventDefault();loadPage(page+1);}
  if(e.code==='ArrowLeft' && e.altKey){e.preventDefault();loadPage(page-1);}
});
let resizeTimer=null;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(pdf)renderPdfPage(page).catch(()=>{});},180);});
window.addEventListener('beforeunload',saveProgress);
