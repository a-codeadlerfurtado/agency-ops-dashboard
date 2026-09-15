from pathlib import Path
import re
BASE=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
app=BASE/'app-v2.mjs'; server=BASE/'server.py'; deploy=BASE/'deploy-reader-app2.ps1'
# --- app ---
s=app.read_text(encoding='utf-8-sig')
for a,b in {
'disponÃ­vel':'disponível',' â€¢ ':' • ','pÃ¡ginas':'páginas','prÃ©-analisado':'pré-analisado',
'PÃ¡gina':'Página','nÃ£o':'não','DisponÃ­vel':'Disponível','IndisponÃ­vel':'Indisponível',
'prÃ©-anÃ¡lise':'pré-análise','prÃ©-aquecendo':'pré-aquecendo','traduÃ§Ã£o':'tradução',
'âœ•':'✕','ðŸ“š':'📚'}.items(): s=s.replace(a,b)
pat=r"function renderLibrary\(\)\{.*?\}\nfunction showLibrary"
new="""function coverUrl(book){return book?.coverUrl||(`${BASE}/assets/${book?.id?.startsWith('kotler')?'cover-kotler.jpg':'cover-zikmund.jpg'}`);}
function renderLibrary(){const grid=$('libraryGrid');if(!grid)return;if(!libraryBooks.length){grid.innerHTML='<div class=\"libraryEmpty\">Nenhum livro disponível no acervo.</div>';return;}grid.innerHTML=libraryBooks.map(b=>{const p=libraryProgress(b),author=(b.authors||[]).join(' • ');return `<article class=\"bookCard\"><div class=\"bookCoverFrame\"><img class=\"bookCoverImg\" src=\"${coverUrl(b)}\" alt=\"Capa de ${b.title||'livro'}\"></div><div><div class=\"bookTitle\">${b.title||'Livro'}</div><div class=\"bookAuthors\">${author}</div><div class=\"bookDesc\">${b.description||'Livro pré-analisado no ReaderPro.'}</div><div class=\"bookProgress\"><i style=\"width:${p.pct}%\"></i></div><div class=\"bookMeta\"><span>${p.has?`Página ${p.page} de ${b.pageCount}`:'Ainda não iniciado'}</span><span>${b.pageCount||0} páginas</span></div><div class=\"bookActions\"><button class=\"btn primary\" data-book-id=\"${b.id}\" ${b.available?'':'disabled'}>${p.has?'Continuar leitura':'Ler agora'}</button></div></div></article>`;}).join('');grid.querySelectorAll('[data-book-id]').forEach(btn=>btn.addEventListener('click',()=>openLibraryBook(btn.dataset.bookId)));}
function showLibrary"""
s,n=re.subn(pat,new,s,count=1,flags=re.S)
if n!=1: raise SystemExit(f'renderLibrary replace={n}')
pat=r"async function openPdfBytes\(bytes,meta,profileHint=null\)\{.*?\$\('file'\)\.addEventListener\('change',async e=>\{.*?\}\);"
new="""async function openPdfSource(source,meta,profileHint=null){stopSpeech();preloadGeneration++;pageTextCache.clear();pdfContentCache.clear();translationCache.clear();audioTimeline=[];bookAnalysis={ready:false,repeated:new Set(),chapters:[]};knownBookProfile=null;knownBookId='';knownBookSha256='';fileMeta=meta;$('docTitle').textContent=String(meta.name||'Livro').replace(/\\.pdf$/i,'');setStatus('Identificando livro e carregando pré-análise...');if(profileHint)activateProfile(profileHint);else if(source instanceof Uint8Array){const profile=await detectKnownBook(source);if(profile)activateProfile(profile);}if(knownBookProfile){$('docTitle').textContent=knownBookProfile.title||$('docTitle').textContent;setStatus(`Acervo reconhecido: ${knownBookProfile.title||'livro pré-analisado'}`);}const task=source instanceof Uint8Array?pdfjsLib.getDocument({data:source}):pdfjsLib.getDocument({url:source,disableRange:false,disableStream:false,disableAutoFetch:false});pdf=await task.promise;page=1;pendingSentenceIndex=null;pendingSentenceOffset=0;restoreProgress();updateAudiobookUi();await loadSavedAnalysis();if(pendingVoice&&[...$('voice').options].some(o=>o.value===pendingVoice)){$('voice').value=pendingVoice;pendingVoice=null;}$('pageTotal').textContent=`/ ${pdf.numPages}`;await loadPage(page,{preservePending:true});if(matchMedia('(max-width:900px)').matches)setMobileView('text');}
async function openPdfBytes(bytes,meta,profileHint=null){return openPdfSource(bytes,meta,profileHint);}
async function openLibraryBook(bookId){const book=libraryBooks.find(b=>b.id===bookId);if(!book||!book.available)return;hideLibrary();setStatus(`Abrindo ${book.title} da biblioteca...`);setBuffer('carregando primeira página');try{await openPdfSource(`${BASE}/api/library/book/${encodeURIComponent(bookId)}`,{name:`${book.title}.pdf`,size:book.size,lastModified:0},book);}catch(e){setStatus(`Falha ao abrir livro: ${e.message||e}`);showLibrary();}}
$('file').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;const bytes=new Uint8Array(await f.arrayBuffer());await openPdfBytes(bytes,{name:f.name,size:f.size,lastModified:f.lastModified});});"""
s,n=re.subn(pat,new,s,count=1,flags=re.S)
if n!=1: raise SystemExit(f'openPdf replace={n}')
insert="""
function setMobileView(view){document.body.dataset.mobileView=view;for(const id of ['mobilePdf','mobileText'])$(id)?.classList.toggle('active',(view==='pdf'&&id==='mobilePdf')||(view==='text'&&id==='mobileText'));}
function syncMobilePlay(){const b=$('mobilePlay');if(!b)return;const icon=b.querySelector('span');if(icon)icon.textContent=speaking&&!paused?'⏸':'▶';for(const node of [...b.childNodes])if(node.nodeType===Node.TEXT_NODE)node.textContent=speaking&&!paused?'Pausar':(paused?'Continuar':'Ouvir');}
$('mobileLibrary')?.addEventListener('click',showLibrary);$('mobilePdf')?.addEventListener('click',()=>setMobileView('pdf'));$('mobileText')?.addEventListener('click',()=>setMobileView('text'));$('mobilePlay')?.addEventListener('click',()=>{toggleSpeech();setTimeout(syncMobilePlay,40);});
new MutationObserver(syncMobilePlay).observe($('play'),{childList:true,subtree:true,characterData:true});
let deferredInstallPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;});
$('installApp')?.addEventListener('click',async()=>{if(deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;return;}$('installHelp')?.classList.toggle('show');});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/reader/sw.js',{scope:'/reader/'}).catch(e=>console.warn('sw_failed',e)));
syncMobilePlay();
"""
marker="$('libraryBtn')?.addEventListener('click',showLibrary);"
if marker not in s: raise SystemExit('app init marker missing')
s=s.replace(marker,insert+'\n'+marker,1)
app.write_text(s,encoding='utf-8')
print('APP_OK')
# --- server ---
s=server.read_text(encoding='utf-8-sig')
anchor='APP = Path("/app/app-v2.mjs") if Path("/app/app-v2.mjs").exists() else Path(__file__).with_name("app-v2.mjs")\n'
if 'MANIFEST = Path(' not in s:
    s=s.replace(anchor,anchor+'MANIFEST = Path("/app/manifest.webmanifest") if Path("/app/manifest.webmanifest").exists() else Path(__file__).with_name("manifest.webmanifest")\nSW = Path("/app/sw.js") if Path("/app/sw.js").exists() else Path(__file__).with_name("sw.js")\nASSET_ROOT = Path("/app/assets") if Path("/app/assets").exists() else Path(__file__).with_name("assets")\n',1)
s=s.replace('"prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[])','"prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[]),\n            "coverUrl": "/reader/assets/cover-kotler.jpg" if str(profile.get("id","")).startswith("kotler") else "/reader/assets/cover-zikmund.jpg"',1)
marker='    def do_GET(self):\n'
if 'def serve_file(self, fp' not in s:
    helper='''    def serve_file(self, fp, content_type, cache_control="public, max-age=86400", allow_range=False):
        fp=Path(fp); size=fp.stat().st_size; start=0; end=size-1; status=200
        m=re.match(r"bytes=(\\d*)-(\\d*)",self.headers.get("Range","") if allow_range else "")
        if m:
            if m.group(1): start=int(m.group(1))
            if m.group(2): end=min(end,int(m.group(2)))
            if start>end or start>=size: self.send_response(416); self.send_header("Content-Range",f"bytes */{size}"); self.end_headers(); return
            status=206
        length=end-start+1; self.send_response(status); self.send_header("Content-Type",content_type); self.send_header("Content-Length",str(length)); self.send_header("Cache-Control",cache_control)
        if allow_range: self.send_header("Accept-Ranges","bytes"); status==206 and self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.end_headers()
        with fp.open("rb") as src:
            src.seek(start); remaining=length
            while remaining>0:
                chunk=src.read(min(1024*1024,remaining))
                if not chunk: break
                self.wfile.write(chunk); remaining-=len(chunk)

'''
    s=s.replace(marker,helper+marker,1)
old='''        if path.startswith("/api/library/book/"):
            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])
            fp=library_path_for(book_id)
            if not fp:return self.send_json(404,{"error":"book_not_available"})
            size=fp.stat().st_size
            self.send_response(200);self.send_header("Content-Type","application/pdf");self.send_header("Content-Length",str(size));self.send_header("Cache-Control","public, max-age=86400");self.end_headers()
            with fp.open("rb") as src:shutil.copyfileobj(src,self.wfile,1024*1024)
            return
'''
new='''        if path.startswith("/api/library/book/"):
            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])
            fp=library_path_for(book_id)
            if not fp:return self.send_json(404,{"error":"book_not_available"})
            return self.serve_file(fp,"application/pdf","public, max-age=86400",allow_range=True)
        if path == "/manifest.webmanifest": return self.serve_file(MANIFEST,"application/manifest+json","no-cache")
        if path == "/sw.js": return self.serve_file(SW,"text/javascript; charset=utf-8","no-cache")
        if path.startswith("/assets/"):
            name=Path(path.split("/assets/",1)[1]).name; fp=ASSET_ROOT/name
            if not fp.exists(): return self.send_error(404)
            return self.serve_file(fp,"image/png" if fp.suffix.lower()==".png" else "image/jpeg","public, max-age=31536000, immutable")
'''
if old not in s: raise SystemExit('server library route block missing')
s=s.replace(old,new,1)
server.write_text(s,encoding='utf-8')
print('SERVER_OK')
