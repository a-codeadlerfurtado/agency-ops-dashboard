from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8-sig')
repls={
'disponÃ­vel':'disponível',' â€¢ ':' • ','pÃ¡ginas':'páginas','prÃ©-analisado':'pré-analisado','PÃ¡gina':'Página','nÃ£o':'não','DisponÃ­vel':'Disponível','IndisponÃ­vel':'Indisponível','prÃ©-anÃ¡lise':'pré-análise','prÃ©-aquecendo':'pré-aquecendo','traduÃ§Ã£o':'tradução','âœ•':'✕','ðŸ“š':'📚'
}
for a,b in repls.items(): s=s.replace(a,b)
old="function renderLibrary(){const grid=$('libraryGrid');if(!grid)return;if(!libraryBooks.length){grid.innerHTML='<div class=\"libraryEmpty\">Nenhum livro disponível no acervo.</div>';return;}grid.innerHTML=libraryBooks.map((b,i)=>{const p=libraryProgress(b),author=(b.authors||[]).join(' • '),short=b.id?.startsWith('kotler')?'KOTLER':'ZIKMUND';return `<article class=\"bookCard\"><div class=\"bookCover\"><span>${b.edition||'ReaderPro'}</span><b>${short}</b><span>${b.pageCount||0} páginas</span></div>"
if old not in s: print('renderLibrary head not exact; using marker mode')
else: print('renderLibrary head found')
p.write_text(s,encoding='utf-8')import re
s=p.read_text(encoding='utf-8')
pat=r"function renderLibrary\(\)\{.*?\}\nfunction showLibrary"
new="""function coverUrl(book){return book?.coverUrl||(`${BASE}/assets/${book?.id?.startsWith('kotler')?'cover-kotler.jpg':'cover-zikmund.jpg'}`);}
function renderLibrary(){const grid=$('libraryGrid');if(!grid)return;if(!libraryBooks.length){grid.innerHTML='<div class=\"libraryEmpty\">Nenhum livro disponível no acervo.</div>';return;}grid.innerHTML=libraryBooks.map(b=>{const p=libraryProgress(b),author=(b.authors||[]).join(' • ');return `<article class=\"bookCard\"><div class=\"bookCoverFrame\"><img class=\"bookCoverImg\" src=\"${coverUrl(b)}\" alt=\"Capa de ${b.title||'livro'}\" loading=\"eager\"></div><div><div class=\"bookTitle\">${b.title||'Livro'}</div><div class=\"bookAuthors\">${author}</div><div class=\"bookDesc\">${b.description||'Livro pré-analisado no ReaderPro.'}</div><div class=\"bookProgress\"><i style=\"width:${p.pct}%\"></i></div><div class=\"bookMeta\"><span>${p.has?`Página ${p.page} de ${b.pageCount}`:'Ainda não iniciado'}</span><span>${b.pageCount||0} páginas</span></div><div class=\"bookActions\"><button class=\"btn primary\" data-book-id=\"${b.id}\" ${b.available?'':'disabled'}>${p.has?'Continuar leitura':'Ler agora'}</button></div></div></article>`;}).join('');grid.querySelectorAll('[data-book-id]').forEach(btn=>btn.addEventListener('click',()=>openLibraryBook(btn.dataset.bookId)));}
function showLibrary"""
s,n=re.subn(pat,new,s,count=1,flags=re.S)
print('renderLibrary replaced',n)
if not n: raise SystemExit('renderLibrary replace failed')
p.write_text(s,encoding='utf-8')s=p.read_text(encoding='utf-8')
pat=r"async function openPdfBytes\(bytes,meta,profileHint=null\)\{.*?\$\('file'\)\.addEventListener\('change',async e=>\{.*?\}\);"
new="""async function openPdfSource(source,meta,profileHint=null){stopSpeech();preloadGeneration++;pageTextCache.clear();pdfContentCache.clear();translationCache.clear();audioTimeline=[];bookAnalysis={ready:false,repeated:new Set(),chapters:[]};knownBookProfile=null;knownBookId='';knownBookSha256='';fileMeta=meta;$('docTitle').textContent=String(meta.name||'Livro').replace(/\\.pdf$/i,'');setStatus('Identificando livro e carregando pré-análise...');if(profileHint)activateProfile(profileHint);else if(source instanceof Uint8Array){const profile=await detectKnownBook(source);if(profile)activateProfile(profile);}if(knownBookProfile){$('docTitle').textContent=knownBookProfile.title||$('docTitle').textContent;setStatus(`Acervo reconhecido: ${knownBookProfile.title||'livro pré-analisado'}`);}const task=source instanceof Uint8Array?pdfjsLib.getDocument({data:source}):pdfjsLib.getDocument({url:source,disableRange:false,disableStream:false,disableAutoFetch:false});pdf=await task.promise;page=1;pendingSentenceIndex=null;pendingSentenceOffset=0;restoreProgress();updateAudiobookUi();await loadSavedAnalysis();if(pendingVoice&&[...$('voice').options].some(o=>o.value===pendingVoice)){$('voice').value=pendingVoice;pendingVoice=null;}$('pageTotal').textContent=`/ ${pdf.numPages}`;await loadPage(page,{preservePending:true});if(matchMedia('(max-width:900px)').matches)setMobileView('text');}
async function openPdfBytes(bytes,meta,profileHint=null){return openPdfSource(bytes,meta,profileHint);}
async function openLibraryBook(bookId){const book=libraryBooks.find(b=>b.id===bookId);if(!book||!book.available)return;hideLibrary();setStatus(`Abrindo ${book.title} da biblioteca...`);setBuffer('carregando primeira página');try{await openPdfSource(`${BASE}/api/library/book/${encodeURIComponent(bookId)}`,{name:`${book.title}.pdf`,size:book.size,lastModified:0},book);}catch(e){setStatus(`Falha ao abrir livro: ${e.message||e}`);showLibrary();}}
$('file').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;const bytes=new Uint8Array(await f.arrayBuffer());await openPdfBytes(bytes,{name:f.name,size:f.size,lastModified:f.lastModified});});"""
s,n=re.subn(pat,new,s,count=1,flags=re.S)
print('open source replaced',n)
if not n: raise SystemExit('open source replace failed')
p.write_text(s,encoding='utf-8')s=p.read_text(encoding='utf-8')
insert="""
function setMobileView(view){document.body.dataset.mobileView=view;for(const id of ['mobilePdf','mobileText'])$(id)?.classList.toggle('active',(view==='pdf'&&id==='mobilePdf')||(view==='text'&&id==='mobileText'));}
function syncMobilePlay(){const b=$('mobilePlay');if(!b)return;const icon=b.querySelector('span');if(icon)icon.textContent=speaking&&!paused?'⏸':'▶';b.lastChild.textContent=speaking&&!paused?'Pausar':(paused?'Continuar':'Ouvir');}
$('mobileLibrary')?.addEventListener('click',showLibrary);$('mobilePdf')?.addEventListener('click',()=>setMobileView('pdf'));$('mobileText')?.addEventListener('click',()=>setMobileView('text'));$('mobilePlay')?.addEventListener('click',()=>{toggleSpeech();setTimeout(syncMobilePlay,30);});
new MutationObserver(syncMobilePlay).observe($('play'),{childList:true,subtree:true,characterData:true});
let deferredInstallPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;});
$('installApp')?.addEventListener('click',async()=>{if(deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;return;}$('installHelp')?.classList.toggle('show');});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/reader/sw.js',{scope:'/reader/'}).catch(e=>console.warn('sw_failed',e)));
syncMobilePlay();
"""
marker="$('libraryBtn')?.addEventListener('click',showLibrary);"
if marker not in s: raise SystemExit('init marker missing')
s=s.replace(marker,insert+'\n'+marker,1)
p.write_text(s,encoding='utf-8')
print('mobile+pwa patched')