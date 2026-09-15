from pathlib import Path
import re
base=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
server=base/'server.py'
index=base/'index.html'
app=base/'app-v2.mjs'
deploy=base/'deploy-reader-app2.ps1'
s=server.read_text(encoding='utf-8')
s=s.replace('import urllib.request\n', 'import urllib.request\nimport urllib.parse\nimport shutil\n',1)
old='PROFILE_PATH = Path("/app/kotler15_profile.json") if Path("/app/kotler15_profile.json").exists() else Path(__file__).with_name("kotler15_profile.json")\nKNOWN_DOCUMENTS = {}\nif PROFILE_PATH.exists():\n    try:\n        _profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))\n        KNOWN_DOCUMENTS[_profile.get("sha256", "")] = _profile\n    except Exception as exc:\n        print(f"profile_load_failed:{exc}")\nKNOWN_BY_ID = {p.get("id"): p for p in KNOWN_DOCUMENTS.values() if p.get("id")}\n'
new='LIBRARY_ROOT = Path(os.getenv("LIBRARY_ROOT", "/library"))\nPROFILE_NAMES = ("kotler15_profile.json", "zikmund4_profile.json")\nKNOWN_DOCUMENTS = {}\nfor _name in PROFILE_NAMES:\n    _candidate = Path("/app") / _name\n    if not _candidate.exists(): _candidate = Path(__file__).with_name(_name)\n    if not _candidate.exists(): continue\n    try:\n        _profile = json.loads(_candidate.read_text(encoding="utf-8"))\n        if _profile.get("sha256"): KNOWN_DOCUMENTS[_profile["sha256"]] = _profile\n    except Exception as exc: print(f"profile_load_failed:{_name}:{exc}")\nKNOWN_BY_ID = {p.get("id"): p for p in KNOWN_DOCUMENTS.values() if p.get("id")}\n'
if old not in s: raise SystemExit('profile block not found')
s=s.replace(old,new,1)
server.write_text(s,encoding='utf-8')
print('server profile loader patched')
s=server.read_text(encoding='utf-8')
old='def sanitize_document_text(text:str,doc_id:str=""):\n    if doc_id!="kotler-keller-marketing-management-15e-global": return text\n    out=[]\n'
new='def sanitize_document_text(text:str,doc_id:str=""):\n    if not doc_id: return text\n    out=[]\n'
if old not in s: raise SystemExit('sanitize head not found')
s=s.replace(old,new,1)
old='        if re.search(r"(?:A|M)\\d{2}_KOTL\\S*\\.indd",line,re.I): continue\n        if line.lower().startswith(("mymarketinglab","improve your grade","source: Â©","source: ")): continue\n'
new='        if doc_id=="kotler-keller-marketing-management-15e-global" and re.search(r"(?:A|M)\\d{2}_KOTL\\S*\\.indd",line,re.I): continue\n        low=line.lower()\n        if low.startswith(("mymarketinglab","improve your grade","source: Â©","source: ")): continue\n        if doc_id=="zikmund-marketing-research-4e-asia-pacific" and low.startswith(("coursemate online study tools","courtesy of qualtrics.com","survey this!")): continue\n'
if old not in s: raise SystemExit('sanitize body not found')
s=s.replace(old,new,1)
old='    if doc_id=="kotler-keller-marketing-management-15e-global":\n        text=re.sub(r"\\bPhilip Kotler\\b","FÃ­lip KÃ³tler",text,flags=re.I)\n        text=re.sub(r"\\bKevin Lane Keller\\b","KÃ©vin Leine KÃ©ler",text,flags=re.I)\n        text=re.sub(r"\\bKotler\\b","KÃ³tler",text)\n        text=re.sub(r"\\bKeller\\b","KÃ©ler",text)\n'
new=old+'    profile=KNOWN_BY_ID.get(doc_id)\n    if profile:\n        for token,spoken in sorted((profile.get("speechTerms") or {}).items(),key=lambda kv:-len(kv[0])):\n            text=re.sub(rf"(?<!\\w){re.escape(token)}(?!\\w)",spoken,text,flags=re.I)\n'
if old not in s: raise SystemExit('speech block not found')
s=s.replace(old,new,1)
server.write_text(s,encoding='utf-8')
print('server book normalization patched')
s=server.read_text(encoding='utf-8')
old='    profile_note = ""\n    if doc_id == "kotler-keller-marketing-management-15e-global":\n        profile_note = "This is Philip Kotler and Kevin Lane Keller, Marketing Management, 15th Global Edition. Use natural Brazilian marketing/business vocabulary, preserve proper names and brand names, and keep terminology consistent across pages."\n'
new='    profile_note = ""\n    profile=KNOWN_BY_ID.get(doc_id)\n    if profile:\n        authors=", ".join(profile.get("authors") or [])\n        profile_note=f"This is {profile.get(\'title\',\'a business textbook\')} by {authors}. Use natural Brazilian academic/business vocabulary, preserve proper names, statistical notation and brand/software names, and keep terminology consistent across pages."\n'
if old not in s: raise SystemExit('context note not found')
s=s.replace(old,new,1)
insert='''\ndef public_library():\n    items=[]\n    for p in KNOWN_BY_ID.values():\n        filename=Path(str(p.get("libraryFile", ""))).name\n        fp=LIBRARY_ROOT/filename if filename else None\n        items.append({"id":p.get("id"),"title":p.get("title"),"edition":p.get("edition",""),"authors":p.get("authors",[]),"description":p.get("description",""),"sha256":p.get("sha256"),"size":p.get("size",0),"pageCount":p.get("pageCount",0),"available":bool(fp and fp.exists()),"warmSentences":p.get("warmSentences",4),"prefetchPages":p.get("prefetchPages",10)})\n    return items\n\ndef library_path_for(book_id):\n    p=KNOWN_BY_ID.get(book_id)\n    if not p: return None\n    filename=Path(str(p.get("libraryFile", ""))).name\n    if not filename: return None\n    fp=(LIBRARY_ROOT/filename).resolve()\n    try: fp.relative_to(LIBRARY_ROOT.resolve())\n    except ValueError: return None\n    return fp if fp.exists() else None\n\n'''
marker='class Handler(BaseHTTPRequestHandler):\n'
if marker not in s: raise SystemExit('handler marker not found')
s=s.replace(marker,insert+marker,1)
server.write_text(s,encoding='utf-8')
print('server library helpers patched')
s=server.read_text(encoding='utf-8')
old='        if path == "/api/voices":\n            try:\n                return self.send_json(200, request_json(f"{TTS_URL}/v1/voices", timeout=30))\n            except Exception as exc:\n                return self.send_json(503, {"error": "tts_not_ready", "detail": str(exc)[:400]})\n'
new=old+'        if path == "/api/library":\n            return self.send_json(200, {"books": public_library()})\n        if path.startswith("/api/library/book/"):\n            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])\n            fp=library_path_for(book_id)\n            if not fp: return self.send_json(404,{"error":"book_not_available"})\n            size=fp.stat().st_size\n            self.send_response(200); self.send_header("Content-Type","application/pdf"); self.send_header("Content-Length",str(size)); self.send_header("Cache-Control","public, max-age=86400"); self.end_headers()\n            with fp.open("rb") as src: shutil.copyfileobj(src,self.wfile,1024*1024)\n            return\n'
if old not in s: raise SystemExit('voices route not found')
s=s.replace(old,new,1)
server.write_text(s,encoding='utf-8')
print('server library routes patched')

# Patch index: styles, button and overlay
h=index.read_text(encoding='utf-8')
css='.libraryOverlay{position:fixed;inset:0;z-index:50;background:#05070bdd;backdrop-filter:blur(18px);display:none;padding:42px;overflow:auto}.libraryOverlay.show{display:block}.libraryShell{max-width:1080px;margin:0 auto}.libraryHead{display:flex;align-items:flex-start;gap:16px;margin-bottom:26px}.libraryHead h1{margin:0;font-size:32px}.libraryHead p{margin:7px 0 0;color:var(--muted)}.libraryGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}.bookCard{border:1px solid var(--line);background:linear-gradient(145deg,#121724,#0d111a);border-radius:22px;padding:18px;display:grid;grid-template-columns:110px 1fr;gap:18px;box-shadow:0 22px 70px #0005}.bookCover{height:158px;border-radius:14px;padding:14px;background:linear-gradient(155deg,#7c3aed,#172554 55%,#083344);display:flex;flex-direction:column;justify-content:space-between;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:800}.bookCover b{font-size:20px;letter-spacing:-.03em;text-transform:none}.bookTitle{font-size:18px;font-weight:850}.bookAuthors{font-size:12px;color:var(--muted);margin-top:5px;line-height:1.45}.bookDesc{font-size:13px;color:#c5ccda;line-height:1.45;margin:12px 0}.bookProgress{height:5px;background:#222936;border-radius:99px;overflow:hidden;margin:9px 0}.bookProgress i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}.bookMeta{font-size:11px;color:var(--muted);display:flex;justify-content:space-between}.bookActions{display:flex;gap:8px;margin-top:13px}.libraryClose{margin-left:auto}.libraryEmpty{color:var(--muted);padding:30px;border:1px dashed var(--line);border-radius:18px}@media(max-width:650px){.libraryOverlay{padding:20px}.bookCard{grid-template-columns:82px 1fr}.bookCover{height:128px;padding:10px}}'
h=h.replace('</style>',css+'\n</style>',1)
h=h.replace('<label class="fileBtn">Abrir PDF', '<button class="btn" id="libraryBtn">ðŸ“š Biblioteca</button>\n    <label class="fileBtn">Abrir PDF',1)
over='''\n<div class="libraryOverlay" id="libraryOverlay"><div class="libraryShell"><div class="libraryHead"><div><div class="eyebrow">Acervo ReaderPro</div><h1>Sua Biblioteca</h1><p>Livros prÃ©-analisados, com traduÃ§Ã£o, voz e progresso individual.</p></div><button class="btn libraryClose" id="libraryClose">Fechar âœ•</button></div><div class="libraryGrid" id="libraryGrid"><div class="libraryEmpty">Carregando biblioteca...</div></div></div></div>\n'''
h=h.replace('<script type="module" src="/reader/app-v2.mjs"></script>',over+'<script type="module" src="/reader/app-v2.mjs"></script>',1)
index.write_text(h,encoding='utf-8')
print('index library UI patched')
a=app.read_text(encoding='utf-8')
needle="let knownBookProfile=null,knownBookId='',knownBookSha256='';"
a=a.replace(needle,needle+"\nlet libraryBooks=[];",1)
insert='''\nfunction libraryProgress(book){try{const raw=localStorage.getItem(`readerpro:${book.sha256}:${book.size}`);const p=JSON.parse(raw||'{}');const pg=Math.max(1,Math.min(Number(book.pageCount)||1,Number(p.page)||1));return{page:pg,pct:Math.max(0,Math.min(100,(pg/Math.max(1,Number(book.pageCount)||1))*100)),has:!!raw};}catch{return{page:1,pct:0,has:false};}}\nfunction renderLibrary(){const grid=$('libraryGrid');if(!grid)return;if(!libraryBooks.length){grid.innerHTML='<div class="libraryEmpty">Nenhum livro disponÃ­vel no acervo.</div>';return;}grid.innerHTML=libraryBooks.map((b,i)=>{const p=libraryProgress(b),author=(b.authors||[]).join(' â€¢ '),short=i===0?'KOTLER':'ZIKMUND';return `<article class="bookCard"><div class="bookCover"><span>${b.edition||'ReaderPro'}</span><b>${short}</b><span>${b.pageCount||0} pÃ¡ginas</span></div><div><div class="bookTitle">${b.title||'Livro'}</div><div class="bookAuthors">${author}</div><div class="bookDesc">${b.description||'Livro prÃ©-analisado no ReaderPro.'}</div><div class="bookProgress"><i style="width:${p.pct}%"></i></div><div class="bookMeta"><span>${p.has?`PÃ¡gina ${p.page} de ${b.pageCount}`:'Ainda nÃ£o iniciado'}</span><span>${b.available?'DisponÃ­vel':'IndisponÃ­vel'}</span></div><div class="bookActions"><button class="btn primary" data-book-id="${b.id}" ${b.available?'':'disabled'}>${p.has?'Continuar leitura':'Ler agora'}</button></div></div></article>`;}).join('');grid.querySelectorAll('[data-book-id]').forEach(btn=>btn.addEventListener('click',()=>openLibraryBook(btn.dataset.bookId)));}\nfunction showLibrary(){renderLibrary();$('libraryOverlay')?.classList.add('show');}\nfunction hideLibrary(){$('libraryOverlay')?.classList.remove('show');}\nasync function loadLibrary(){try{const r=await fetch(BASE+'/api/library'),d=await r.json();libraryBooks=Array.isArray(d.books)?d.books:[];renderLibrary();}catch(e){console.warn('library_load_failed',e);}}\nfunction activateProfile(profile){knownBookProfile=profile||null;knownBookId=String(profile?.id||'');knownBookSha256=String(profile?.sha256||'');activeDocHash=knownBookSha256;activeDocProfile=profile||null;if(Array.isArray(profile?.chapters))bookAnalysis.chapters=profile.chapters;}\n'''
marker='function saveProgress(){'
if marker not in a: raise SystemExit('app saveProgress marker missing')
a=a.replace(marker,insert+'\n'+marker,1)
app.write_text(a,encoding='utf-8')
print('app library state patched')
a=app.read_text(encoding='utf-8')
old="$('file').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;stopSpeech();preloadGeneration++;pageTextCache.clear();pdfContentCache.clear();translationCache.clear();audioTimeline=[];bookAnalysis={ready:false,repeated:new Set(),chapters:[]};knownBookProfile=null;knownBookId='';knownBookSha256='';fileMeta={name:f.name,size:f.size,lastModified:f.lastModified};$('docTitle').textContent=f.name.replace(/\\.pdf$/i,'');setStatus('Abrindo PDF...');const bytes=new Uint8Array(await f.arrayBuffer());setStatus('Identificando livro e carregando pre-analise...');const profile=await detectKnownBook(bytes);if(profile){$('docTitle').textContent=profile.title||f.name.replace(/\\.pdf$/i,'');setStatus(`Acervo reconhecido: ${profile.title||'livro pre-analisado'}`);}pdf=await pdfjsLib.getDocument({data:bytes}).promise;page=1;pendingSentenceIndex=null;pendingSentenceOffset=0;restoreProgress();updateAudiobookUi();await loadSavedAnalysis();if(pendingVoice&&[...$('voice').options].some(o=>o.value===pendingVoice)){$('voice').value=pendingVoice;pendingVoice=null;}$('pageTotal').textContent=`/ ${pdf.numPages}`;await loadPage(page,{preservePending:true});});"
new='''async function openPdfBytes(bytes,meta,profileHint=null){stopSpeech();preloadGeneration++;pageTextCache.clear();pdfContentCache.clear();translationCache.clear();audioTimeline=[];bookAnalysis={ready:false,repeated:new Set(),chapters:[]};knownBookProfile=null;knownBookId='';knownBookSha256='';fileMeta=meta;$('docTitle').textContent=String(meta.name||'Livro').replace(/\\.pdf$/i,'');setStatus('Identificando livro e carregando prÃ©-anÃ¡lise...');if(profileHint)activateProfile(profileHint);else{const profile=await detectKnownBook(bytes);if(profile)activateProfile(profile);}if(knownBookProfile){$('docTitle').textContent=knownBookProfile.title||$('docTitle').textContent;setStatus(`Acervo reconhecido: ${knownBookProfile.title||'livro prÃ©-analisado'}`);}pdf=await pdfjsLib.getDocument({data:bytes}).promise;page=1;pendingSentenceIndex=null;pendingSentenceOffset=0;restoreProgress();updateAudiobookUi();await loadSavedAnalysis();if(pendingVoice&&[...$('voice').options].some(o=>o.value===pendingVoice)){$('voice').value=pendingVoice;pendingVoice=null;}$('pageTotal').textContent=`/ ${pdf.numPages}`;await loadPage(page,{preservePending:true});}\nasync function openLibraryBook(bookId){const book=libraryBooks.find(b=>b.id===bookId);if(!book||!book.available)return;hideLibrary();setStatus(`Abrindo ${book.title} da biblioteca...`);setBuffer('carregando livro do acervo');try{const r=await fetch(`${BASE}/api/library/book/${encodeURIComponent(bookId)}`);if(!r.ok)throw new Error(`Biblioteca ${r.status}`);const bytes=new Uint8Array(await r.arrayBuffer());await openPdfBytes(bytes,{name:`${book.title}.pdf`,size:book.size,lastModified:0},book);}catch(e){setStatus(`Falha ao abrir livro: ${e.message||e}`);showLibrary();}}\n$('file').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;const bytes=new Uint8Array(await f.arrayBuffer());await openPdfBytes(bytes,{name:f.name,size:f.size,lastModified:f.lastModified});});'''
if old not in a: raise SystemExit('file event block not found')
a=a.replace(old,new,1)
app.write_text(a,encoding='utf-8')
print('app open library patched')
a=app.read_text(encoding='utf-8')
old='updateAudiobookUi();populateVoices();'
new="$('libraryBtn')?.addEventListener('click',showLibrary);$('libraryClose')?.addEventListener('click',hideLibrary);$('libraryOverlay')?.addEventListener('click',e=>{if(e.target===$('libraryOverlay'))hideLibrary();});updateAudiobookUi();populateVoices();loadLibrary().then(()=>{if(!pdf)showLibrary();});"
if old not in a: raise SystemExit('app init marker not found')
a=a.replace(old,new,1)
app.write_text(a,encoding='utf-8')
print('app library init patched')

# Deploy: second profile + persistent PDF volume
d=deploy.read_text(encoding='utf-8')
d=d.replace('$profileCfg=New-DockerConfig "reader-ia-kotler-profile-$stamp" (Join-Path $dir \'kotler15_profile.json\')', '$profileCfg=New-DockerConfig "reader-ia-kotler-profile-$stamp" (Join-Path $dir \'kotler15_profile.json\')\n$zikmundCfg=New-DockerConfig "reader-ia-zikmund-profile-$stamp" (Join-Path $dir \'zikmund4_profile.json\')',1)
d=d.replace("'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache')", "'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache','LIBRARY_ROOT=/library')",1)
d=d.replace("Mounts=@(@{Type='volume';Source='readerpro-reader-cache';Target='/cache'})", "Mounts=@(@{Type='volume';Source='readerpro-reader-cache';Target='/cache'},@{Type='volume';Source='readerpro-library';Target='/library';ReadOnly=$true})",1)
needle='@{ConfigID=$profileCfg.ID;ConfigName="reader-ia-kotler-profile-$stamp";File=@{Name=\'/app/kotler15_profile.json\';UID=\'0\';GID=\'0\';Mode=292}}'
repl=needle+',\n        @{ConfigID=$zikmundCfg.ID;ConfigName="reader-ia-zikmund-profile-$stamp";File=@{Name=\'/app/zikmund4_profile.json\';UID=\'0\';GID=\'0\';Mode=292}}'
if needle not in d: raise SystemExit('deploy profile config marker missing')
d=d.replace(needle,repl,1)
deploy.write_text(d,encoding='utf-8-sig')
print('deploy library volume patched')
