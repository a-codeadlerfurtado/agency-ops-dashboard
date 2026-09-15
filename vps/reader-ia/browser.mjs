
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

const $=id=>document.getElementById(id);
const BASE='/reader';
let pdf=null,page=1,fileMeta=null,renderToken=0,activeDocProfile=null,activeDocHash=null,prefetchToken=0;
let speaking=false,paused=false,sentenceIndex=0,currentSentences=[],pendingSentenceIndex=null,pendingVoice=null;
let currentAudio=null,currentAudioUrl=null,audioRequestToken=0;
const audioCache=new Map(),audioPending=new Map();
const pageTextCache=new Map(),translationCache=new Map();

function setStatus(text){$('status').textContent=text;}
function setBuffer(text,ready=false){
  $('bufferBadge').textContent=text;
  $('bufferBadge').style.color=ready?'#7ee2b8':'#9ba7bd';
}
function bookKey(){return fileMeta?`reader:${activeDocHash||fileMeta.name}:${fileMeta.size}`:null;}
async function sha256Bytes(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function resolveDocumentProfile(bytes){activeDocHash=await sha256Bytes(bytes);try{const r=await fetch(BASE+'/api/document-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sha256:activeDocHash,size:fileMeta?.size||0,pageCount:pdf?.numPages||0})});const d=await r.json();activeDocProfile=d?.known?d.profile:null;}catch{activeDocProfile=null;}return activeDocProfile;}
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
  if(typeof Intl!=='undefined'&&Intl.Segmenter){const seg=new Intl.Segmenter('pt-BR',{granularity:'sentence'});return [...seg.segment(text)].map(x=>x.segment.trim()).filter(Boolean);}
  return (text.match(/[^.!?â€¦]+(?:[.!?â€¦]+|$)/g)||[text]).map(s=>s.trim()).filter(Boolean);
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
  if(active) active.scrollIntoView({behavior:'smooth',block:'center'});
  const pct=currentSentences.length?Math.min(100,(sentenceIndex/currentSentences.length)*100):0;
  $('progressBar').style.width=pct+'%';
  $('progressText').textContent=currentSentences.length?`Frase ${Math.min(sentenceIndex+1,currentSentences.length)} de ${currentSentences.length} Ã¢â‚¬Â¢ pÃƒÂ¡gina ${page}`:`PÃƒÂ¡gina ${page}`;
}
async function extractPageText(n){
  if(pageTextCache.has(n)) return pageTextCache.get(n);
  const p=await pdf.getPage(n);
  const content=await p.getTextContent();
  let out='',lastY=null;
  for(const item of content.items){
    const y=item.transform?.[5];
    if(lastY!==null && Math.abs(y-lastY)>6) out+='\n';
    else if(out && !out.endsWith('\n')) out+=' ';
    out+=item.str;
    lastY=y;
  }
  out=out.replace(/\s+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  pageTextCache.set(n,out);
  return out;
}
async function translatePage(n){
  if(translationCache.has(n)) return translationCache.get(n);
  const original=await extractPageText(n);
  if(!original){translationCache.set(n,'');return '';}
  let context='';
  if(n>1){try{context=(await extractPageText(n-1)).slice(-2200);}catch{}}
  const res=await fetch(BASE+'/api/translate',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:original,context,source:'en',target:'pt',docId:activeDocProfile?.id||''})
  });
  const data=await res.json();
  if(!res.ok) throw new Error(data.detail||data.error||'Falha na traduÃƒÂ§ÃƒÂ£o');
  const translated=data.translatedText||'';
  translationCache.set(n,translated);
  return translated;
}
async function warmUpcomingPages(startPage){
  const token=++prefetchToken;
  const count=Math.min(activeDocProfile?.prefetchPages||1,Math.max(0,pdf.numPages-startPage));
  if(!count)return;
  for(let offset=1;offset<=count;offset++){
    if(token!==prefetchToken)return;
    const target=startPage+offset;
    setBuffer(`prÃ©-anÃ¡lise ${offset}/${count} pÃ¡ginas`);
    try{
      const txt=await translatePage(target);
      if(offset===1 && $('voice').value!=='system:browser') splitSentences(txt).slice(0,2).forEach(t=>getLocalAudio(t).catch(()=>{}));
    }catch(err){console.warn('prefetch_page_failed',target,err);}
  }
  if(token===prefetchToken)setBuffer(`${count} pÃ¡ginas prÃ©-analisadas`,true);
}
async function renderPdfPage(n){
  const token=++renderToken;
  $('pdfLoading').classList.add('show');
  const pdfPage=await pdf.getPage(n);
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
  fresh.setAttribute('aria-label',`PÃƒÂ¡gina ${n} do PDF`);
  const ctx=fresh.getContext('2d',{alpha:false});
  ctx.setTransform(ratio,0,0,ratio,0,0);
  await pdfPage.render({canvasContext:ctx,viewport}).promise;
  if(token!==renderToken) return;
  const wrap=document.querySelector('.pdfWrap');
  const oldCanvas=wrap.querySelector('canvas');
  fresh.id='canvas';
  if(oldCanvas) oldCanvas.replaceWith(fresh); else wrap.appendChild(fresh);
  $('pdfLoading').classList.remove('show');
}

async function loadPage(n,{autoplay=false}={}){
  if(!pdf) return;
  stopSpeech();
  page=Math.min(Math.max(1,n),pdf.numPages);
  $('pageNum').value=page;$('pageTotal').textContent=`/ ${pdf.numPages}`;
  setStatus(`PÃƒÂ¡gina ${page}: preparando traduÃƒÂ§ÃƒÂ£o em portuguÃƒÂªs...`);
  renderPdfPage(page).catch(err=>{
    $('pdfLoading').classList.remove('show');
    console.error('pdf_render_failed',err);
  });
  try{
    const translated=await translatePage(page);
    renderSentences(translated||'Nenhum texto reconhecido nesta pÃƒÂ¡gina.');
    setStatus(`PÃƒÂ¡gina ${page} pronta Ã¢â‚¬Â¢ traduÃƒÂ§ÃƒÂ£o EN Ã¢â€ â€™ PT-BR`);
    saveProgress();
    if(page<pdf.numPages) warmUpcomingPages(page).catch(()=>setBuffer('buffer pendente'));
    if(autoplay && translated) startSpeech();
  }catch(err){
    $('translation').innerHTML='<div class="empty">NÃƒÂ£o consegui traduzir esta pÃƒÂ¡gina.</div>';
    setStatus(`Falha na traduÃƒÂ§ÃƒÂ£o: ${String(err.message||err)}`);
    setBuffer('erro de traduÃƒÂ§ÃƒÂ£o');
  }
}
function cleanupAudio(){
  if(currentAudio){currentAudio.pause();currentAudio.src='';currentAudio=null;}
  if(currentAudioUrl){URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=null;}
}
function stopSpeech(){
  audioRequestToken++;cleanupAudio();speechSynthesis.cancel();
  speaking=false;paused=false;
  $('play').textContent='Ã¢â€“Â¶ Ouvir';$('play').classList.remove('playing');
  updateSentenceHighlight();
}
const voiceGroups={p:'Ã°Å¸â€¡Â§Ã°Å¸â€¡Â· PortuguÃƒÂªs (recomendadas)',a:'Ã°Å¸â€¡ÂºÃ°Å¸â€¡Â¸ InglÃƒÂªs americano',b:'Ã°Å¸â€¡Â¬Ã°Å¸â€¡Â§ InglÃƒÂªs britÃƒÂ¢nico',e:'Ã°Å¸â€¡ÂªÃ°Å¸â€¡Â¸ Espanhol',f:'Ã°Å¸â€¡Â«Ã°Å¸â€¡Â· FrancÃƒÂªs',h:'Ã°Å¸â€¡Â®Ã°Å¸â€¡Â³ Hindi',i:'Ã°Å¸â€¡Â®Ã°Å¸â€¡Â¹ Italiano',j:'Ã°Å¸â€¡Â¯Ã°Å¸â€¡Âµ JaponÃƒÂªs',z:'Ã°Å¸â€¡Â¨Ã°Å¸â€¡Â³ Mandarim'};
async function populateVoices(){
  const select=$('voice');
  select.innerHTML='<option>Carregando vozes locais...</option>';
  try{
    const res=await fetch(BASE+'/api/voices');
    const data=await res.json();
    if(!res.ok) throw new Error(data.detail||data.error||'TTS indisponÃƒÂ­vel');
    const list=Array.isArray(data.voices)?data.voices:[];
    select.innerHTML='';
    const byGroup={};
    list.forEach(v=>{const g=(v.id||'a')[0];(byGroup[g]??=[]).push(v);});
    ['p','a','b','e','f','h','i','j','z'].forEach(g=>{
      if(!byGroup[g]?.length)return;
      const og=document.createElement('optgroup');og.label=voiceGroups[g]||g;
      byGroup[g].forEach(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=`${v.id} Ã¢â‚¬â€ ${v.description||''}`;og.appendChild(o);});
      select.appendChild(og);
    });
    const og=document.createElement('optgroup');og.label='Ã°Å¸â€™Â» Voz do navegador (fallback)';
    const o=document.createElement('option');o.value='system:browser';o.textContent='Voz padrÃƒÂ£o do Windows/Chrome';og.appendChild(o);select.appendChild(og);
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
  const speed=Number($('rate').value)||1;
  const key=`${voice}|${speed}|${text}`;
  if(audioCache.has(key)) return audioCache.get(key);
  if(audioPending.has(key)) return audioPending.get(key);
  const pending=(async()=>{
    const res=await fetch(BASE+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice,speed,docId:activeDocProfile?.id||''})});
    if(!res.ok){let d={};try{d=await res.json()}catch{};throw new Error(d.detail||d.error||`TTS ${res.status}`);}
    const blob=await res.blob();
    audioCache.set(key,blob);
    if(audioCache.size>80) audioCache.delete(audioCache.keys().next().value);
    return blob;
  })();
  audioPending.set(key,pending);
  try{return await pending;}finally{audioPending.delete(key);}
}

function warmCurrentPageAudio(text){
  if(voice.value==='system:browser')return;
  const count=Math.min(4,activeDocProfile?.warmSentences||3);
  splitSentences(text).slice(0,count).forEach(t=>getLocalAudio(t).catch(()=>{}));
}
function prebufferUpcoming(count=Math.min(4,activeDocProfile?.warmSentences||3)){
  if($('voice').value==='system:browser') return;
  for(let i=1;i<=count;i++){
    const idx=sentenceIndex+i;
    if(idx<currentSentences.length) getLocalAudio(currentSentences[idx]).catch(()=>{});
  }
}
function advanceSentence(){
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
async function speakCurrentSentence(){
  if(!speaking)return;
  if(sentenceIndex>=currentSentences.length){
    if(page<pdf.numPages)return loadPage(page+1,{autoplay:true});
    stopSpeech();$('progressBar').style.width='100%';$('progressText').textContent='Fim do documento';return;
  }
  if($('voice').value==='system:browser') return speakBrowserSentence();
  const token=++audioRequestToken;cleanupAudio();updateSentenceHighlight();setBuffer('gerando voz local');
  try{
    const blob=await getLocalAudio(currentSentences[sentenceIndex]);
    if(token!==audioRequestToken||!speaking)return;
    currentAudioUrl=URL.createObjectURL(blob);currentAudio=new Audio(currentAudioUrl);
    currentAudio.onplay=()=>{setBuffer('voz local Ã¢â‚¬Â¢ buffer pronto',true);updateSentenceHighlight();prebufferUpcoming(3);};
    currentAudio.onended=()=>{cleanupAudio();advanceSentence();};
    currentAudio.onerror=()=>{setStatus('Falha ao reproduzir a voz local.');stopSpeech();};
    if(!paused) await currentAudio.play();
  }catch(err){setStatus(`Voz local: ${err.message||err}`);stopSpeech();}
}
function startSpeech(){
  if(!currentSentences.length)return;
  speaking=true;paused=false;$('play').textContent='Ã¢ÂÂ¸ Pausar';$('play').classList.add('playing');updateSentenceHighlight();prebufferUpcoming(3);speakCurrentSentence();
}
function toggleSpeech(){
  if(!speaking){startSpeech();return;}
  if(!paused){
    paused=true;if(currentAudio)currentAudio.pause();else speechSynthesis.pause();$('play').textContent='Ã¢â€“Â¶ Continuar';
  }else{
    paused=false;$('play').textContent='Ã¢ÂÂ¸ Pausar';
    if(currentAudio)currentAudio.play();else if($('voice').value==='system:browser')speechSynthesis.resume();else speakCurrentSentence();
  }
}

$('play').addEventListener('click',toggleSpeech);
$('prev').addEventListener('click',()=>loadPage(page-1));
$('next').addEventListener('click',()=>loadPage(page+1));
$('pageNum').addEventListener('change',()=>loadPage(Number($('pageNum').value)||1));
$('rate').addEventListener('change',()=>{
  saveProgress();
  if(speaking){
    const wasPaused=paused;audioRequestToken++;cleanupAudio();speechSynthesis.cancel();
    if(!wasPaused){paused=false;setTimeout(()=>speakCurrentSentence(),60);}
  }
});
$('voice').addEventListener('change',()=>{
  localStorage.setItem('reader:lastVoice',$('voice').value);saveProgress();
  if(speaking){const wasPaused=paused;audioRequestToken++;cleanupAudio();speechSynthesis.cancel();if(!wasPaused){paused=false;setTimeout(()=>speakCurrentSentence(),60);}}
});

$('file').addEventListener('change',async e=>{
  const f=e.target.files?.[0];if(!f)return;
  stopSpeech();prefetchToken++;pageTextCache.clear();translationCache.clear();activeDocProfile=null;activeDocHash=null;
  fileMeta={name:f.name,size:f.size,lastModified:f.lastModified};
  $('docTitle').textContent=f.name.replace(/\.pdf$/i,'');
  setStatus('Abrindo PDF e carregando prÃ©-anÃ¡lise...');
  const bytes=new Uint8Array(await f.arrayBuffer());
  const profilePromise=resolveDocumentProfile(bytes);
  pdf=await pdfjsLib.getDocument({data:bytes}).promise;
  await profilePromise;
  if(activeDocProfile){$('docTitle').textContent=activeDocProfile.title;setBuffer('livro reconhecido â€¢ mapa de leitura pronto',true);setStatus(`PrÃ©-anÃ¡lise carregada: ${activeDocProfile.chapters?.length||0} capÃ­tulos â€¢ ${activeDocProfile.glossaryTerms?.length||0}+ termos`);}
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


