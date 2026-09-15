from pathlib import Path
import re
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
server=root/'server.py'
s=server.read_text(encoding='utf-8-sig')
if 'import json' not in s.splitlines()[:10]:
    s=s.replace('import os\n','import os\nimport json\nimport hashlib\nimport re\n',1)
needle='INDEX = Path("/app/index.html") if Path("/app/index.html").exists() else Path(__file__).with_name("index.html")\n'
insert='''INDEX = Path("/app/index.html") if Path("/app/index.html").exists() else Path(__file__).with_name("index.html")
CACHE_ROOT = Path(os.getenv("CACHE_ROOT", "/cache"))
TRANSLATION_CACHE_DIR = CACHE_ROOT / "translations"
TRANSLATION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
PROFILE_PATH = Path("/app/kotler15_profile.json") if Path("/app/kotler15_profile.json").exists() else Path(__file__).with_name("kotler15_profile.json")
KNOWN_DOCUMENTS = {}
if PROFILE_PATH.exists():
    try:
        _profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        KNOWN_DOCUMENTS[_profile.get("sha256", "")] = _profile
    except Exception as exc:
        print(f"profile_load_failed:{exc}")
KNOWN_BY_ID = {p.get("id"): p for p in KNOWN_DOCUMENTS.values() if p.get("id")}
'''
if needle in s and 'TRANSLATION_CACHE_DIR' not in s:
    s=s.replace(needle,insert,1)
helper_needle='def request_json(url, payload=None, timeout=120):\n'
helpers=r'''PT_LETTERS={"A":"á","B":"bê","C":"cê","D":"dê","E":"ê","F":"éfe","G":"gê","H":"agá","I":"i","J":"jóta","K":"cá","L":"éle","M":"ême","N":"êne","O":"ó","P":"pê","Q":"quê","R":"érre","S":"ésse","T":"tê","U":"u","V":"vê","W":"dáblio","X":"xis","Y":"ípsilon","Z":"zê"}
SPEECH_EXCEPTIONS={"B2B":"bê dois bê","B2C":"bê dois cê","ROI":"rói","SWOT":"suót","CEO":"cí i ô","CMO":"cí em ô","SEO":"ésse ê ó","CRM":"cê érre ême","KPI":"cá pê í","NPS":"êne pê ésse","P&G":"pê e gê","R&D":"érre e dê","AT&T":"êi ti end ti","IBM":"ai bi em","BMW":"bê ême dáblio","IKEA":"iquéia","LEGO":"lêgo","GEICO":"gáico"}
WORD_ACRONYMS={"IKEA","LEGO","SABIC","GEICO","IDEO","ALDI","MINI","NASCAR","ARAMARK"}

def sanitize_document_text(text:str,doc_id:str=""):
    if doc_id!="kotler-keller-marketing-management-15e-global": return text
    out=[]
    for raw in (text or "").splitlines():
        line=" ".join(raw.split()).strip()
        if not line: continue
        if re.fullmatch(r"\d{1,4}",line): continue
        if re.search(r"(?:A|M)\d{2}_KOTL\S*\.indd",line,re.I): continue
        if line.lower().startswith(("mymarketinglab","improve your grade","source: ©","source: ")): continue
        if re.fullmatch(r"(?:www\.|https?://)\S+",line,re.I): continue
        out.append(line)
    return "\n".join(out)

def normalize_speech_text(text:str,doc_id:str=""):
    text=" ".join((text or "").split())
    if doc_id=="kotler-keller-marketing-management-15e-global":
        text=re.sub(r"\bPhilip Kotler\b","Fílip Kótler",text,flags=re.I)
        text=re.sub(r"\bKevin Lane Keller\b","Kévin Leine Kéler",text,flags=re.I)
        text=re.sub(r"\bKotler\b","Kótler",text)
        text=re.sub(r"\bKeller\b","Kéler",text)
    for token,spoken in sorted(SPEECH_EXCEPTIONS.items(),key=lambda kv:-len(kv[0])):
        text=re.sub(rf"(?<!\w){re.escape(token)}(?!\w)",spoken,text,flags=re.I)
    text=re.sub(r"(\d+(?:[\.,]\d+)?)\s*%",r"\1 por cento",text)
    def spell(m):
        token=m.group(0)
        if token in WORD_ACRONYMS:return token
        return " ".join(PT_LETTERS.get(ch,ch) for ch in token)
    text=re.sub(r"\b[A-Z]{2,5}\b",spell,text)
    return text

def translation_cache_path(text,context,source,target,doc_id):
    key=hashlib.sha256(f"v4|{TRANSLATION_MODEL}|{doc_id}|{source}|{target}|{text}|{context[-2200:]}".encode("utf-8")).hexdigest()
    return TRANSLATION_CACHE_DIR/f"{key}.txt"

'''
if helper_needle in s and 'def normalize_speech_text' not in s:
    s=s.replace(helper_needle,helpers+helper_needle,1)
s=s.replace('def contextual_translate(text: str, context: str = ""):\n    prompt = f"""You are a professional English (en) to Brazilian Portuguese (pt-BR) translator.', 'def contextual_translate(text: str, context: str = "", doc_id: str = ""):\n    profile_note = ""\n    if doc_id == "kotler-keller-marketing-management-15e-global":\n        profile_note = "This is Philip Kotler and Kevin Lane Keller, Marketing Management, 15th Global Edition. Use natural Brazilian marketing/business vocabulary, preserve proper names and brand names, and keep terminology consistent across pages."\n    prompt = f"""You are a professional English (en) to Brazilian Portuguese (pt-BR) translator. {profile_note}',1)
old='''            if path == "/api/translate":
                text = str(request_data.get("text", "")).strip()
                context = str(request_data.get("context", "")).strip()
                source = str(request_data.get("source", "en"))
                target = str(request_data.get("target", "pt"))
                mode = str(request_data.get("mode", "editorial"))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
'''
new='''            if path == "/api/document-profile":
                sha256 = str(request_data.get("sha256", "")).lower().strip()
                profile = KNOWN_DOCUMENTS.get(sha256)
                return self.send_json(200, {"known": bool(profile), "profile": profile})
            if path == "/api/translate":
                doc_id = str(request_data.get("docId", "")).strip()
                text = sanitize_document_text(str(request_data.get("text", "")).strip(), doc_id)
                context = sanitize_document_text(str(request_data.get("context", "")).strip(), doc_id)
                source = str(request_data.get("source", "en"))
                target = str(request_data.get("target", "pt"))
                mode = str(request_data.get("mode", "editorial"))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                cache_path = translation_cache_path(text, context, source, target, doc_id)
                if cache_path.exists():
                    return self.send_json(200, {"translatedText": cache_path.read_text(encoding="utf-8"), "engine": "persistent-cache"})
'''
if old not in s: raise SystemExit('translate block not found')
s=s.replace(old,new,1)
s=s.replace('translated = contextual_translate(text, context)\n                        return self.send_json(200, {"translatedText": translated, "engine": "local-contextual"})','translated = contextual_translate(text, context, doc_id)\n                        cache_path.write_text(translated, encoding="utf-8")\n                        return self.send_json(200, {"translatedText": translated, "engine": "local-contextual"})',1)
s=s.replace('translated = [translate_chunk(chunk, source, target) for chunk in split_text(text)]\n                return self.send_json(200, {"translatedText": "\\n".join(translated), "engine": "literal-fallback"})','translated = "\\n".join(translate_chunk(chunk, source, target) for chunk in split_text(text))\n                cache_path.write_text(translated, encoding="utf-8")\n                return self.send_json(200, {"translatedText": translated, "engine": "literal-fallback"})',1)
old='''            if path == "/api/tts":
                text = str(request_data.get("text", "")).strip()
                voice = str(request_data.get("voice", "pm_alex"))
                speed = float(request_data.get("speed", 1.0))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                audio, content_type = synthesize(text, voice, speed)
'''
new='''            if path == "/api/tts":
                doc_id = str(request_data.get("docId", "")).strip()
                text = str(request_data.get("text", "")).strip()
                voice = str(request_data.get("voice", "pm_jarvis"))
                speed = float(request_data.get("speed", 1.0))
                if not text:
                    return self.send_json(400, {"error": "empty_text"})
                spoken_text = normalize_speech_text(text, doc_id)
                audio, content_type = synthesize(spoken_text, voice, speed)
'''
if old not in s: raise SystemExit('tts block not found')
s=s.replace(old,new,1)
server.write_text(s,encoding='utf-8')

browser=root/'browser.mjs'
b=browser.read_text(encoding='utf-8-sig')
b=b.replace('let pdf=null,page=1,fileMeta=null,renderToken=0;','let pdf=null,page=1,fileMeta=null,renderToken=0,activeDocProfile=null,activeDocHash=null,prefetchToken=0;',1)
b=b.replace("function bookKey(){return fileMeta?`reader:${fileMeta.name}:${fileMeta.size}`:null;}","function bookKey(){return fileMeta?`reader:${activeDocHash||fileMeta.name}:${fileMeta.size}`:null;}\nasync function sha256Bytes(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}\nasync function resolveDocumentProfile(bytes){activeDocHash=await sha256Bytes(bytes);try{const r=await fetch(BASE+'/api/document-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sha256:activeDocHash,size:fileMeta?.size||0,pageCount:pdf?.numPages||0})});const d=await r.json();activeDocProfile=d?.known?d.profile:null;}catch{activeDocProfile=null;}return activeDocProfile;}",1)
old_split="function splitSentences(text){\n  return (text.match(/[^.!?â€¦]+(?:[.!?â€¦]+|$)/g)||[text]).map(s=>s.trim()).filter(Boolean);\n}"
new_split="function splitSentences(text){\n  if(typeof Intl!=='undefined'&&Intl.Segmenter){const seg=new Intl.Segmenter('pt-BR',{granularity:'sentence'});return [...seg.segment(text)].map(x=>x.segment.trim()).filter(Boolean);}\n  return (text.match(/[^.!?…]+(?:[.!?…]+|$)/g)||[text]).map(s=>s.trim()).filter(Boolean);\n}"
if old_split not in b: raise SystemExit('split block not found')
b=b.replace(old_split,new_split,1)
old='''async function translatePage(n){
  if(translationCache.has(n)) return translationCache.get(n);
  const original=await extractPageText(n);
  if(!original){translationCache.set(n,'');return '';}
  const res=await fetch(BASE+'/api/translate',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:original,source:'en',target:'pt'})
  });
'''
new='''async function translatePage(n){
  if(translationCache.has(n)) return translationCache.get(n);
  const original=await extractPageText(n);
  if(!original){translationCache.set(n,'');return '';}
  let context='';
  if(n>1){try{context=(await extractPageText(n-1)).slice(-2200);}catch{}}
  const res=await fetch(BASE+'/api/translate',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:original,context,source:'en',target:'pt',docId:activeDocProfile?.id||''})
  });
'''
if old not in b: raise SystemExit('translatePage head not found')
b=b.replace(old,new,1)
insert_after='''  translationCache.set(n,translated);
  return translated;
}
'''
warm='''  translationCache.set(n,translated);
  return translated;
}
async function warmUpcomingPages(startPage){
  const token=++prefetchToken;
  const count=Math.min(activeDocProfile?.prefetchPages||1,Math.max(0,pdf.numPages-startPage));
  if(!count)return;
  for(let offset=1;offset<=count;offset++){
    if(token!==prefetchToken)return;
    const target=startPage+offset;
    setBuffer(`pré-análise ${offset}/${count} páginas`);
    try{
      const txt=await translatePage(target);
      if(offset===1 && $('voice').value!=='system:browser') splitSentences(txt).slice(0,2).forEach(t=>getLocalAudio(t).catch(()=>{}));
    }catch(err){console.warn('prefetch_page_failed',target,err);}
  }
  if(token===prefetchToken)setBuffer(`${count} páginas pré-analisadas`,true);
}
'''
if b.count(insert_after)<1: raise SystemExit('translation function tail not found')
b=b.replace(insert_after,warm,1)
oldblock='''    if(page<pdf.numPages){
      setBuffer('prÃ©-carregando prÃ³xima');
      translatePage(page+1).then(nextText=>{
        setBuffer('prÃ³xima pronta',true);
        if($('voice').value!=='system:browser'){
          splitSentences(nextText).slice(0,2).forEach(t=>getLocalAudio(t).catch(()=>{}));
        }
      }).catch(()=>setBuffer('buffer pendente'));
    }
'''
if oldblock not in b: raise SystemExit('old prefetch block not found')
b=b.replace(oldblock,"    if(page<pdf.numPages) warmUpcomingPages(page).catch(()=>setBuffer('buffer pendente'));\n",1)
b=b.replace("body:JSON.stringify({text,voice,speed})","body:JSON.stringify({text,voice,speed,docId:activeDocProfile?.id||''})",1)
b=b.replace('function prebufferUpcoming(count=3){','function prebufferUpcoming(count=activeDocProfile?.warmSentences||3){',1)
old_file='''$('file').addEventListener('change',async e=>{
  const f=e.target.files?.[0];if(!f)return;
  stopSpeech();pageTextCache.clear();translationCache.clear();
  fileMeta={name:f.name,size:f.size,lastModified:f.lastModified};
  $('docTitle').textContent=f.name.replace(/\\.pdf$/i,'');
  setStatus('Abrindo PDF...');
  const bytes=new Uint8Array(await f.arrayBuffer());
  pdf=await pdfjsLib.getDocument({data:bytes}).promise;
  page=1;pendingSentenceIndex=null;
  restoreProgress();
'''
new_file='''$('file').addEventListener('change',async e=>{
  const f=e.target.files?.[0];if(!f)return;
  stopSpeech();prefetchToken++;pageTextCache.clear();translationCache.clear();activeDocProfile=null;activeDocHash=null;
  fileMeta={name:f.name,size:f.size,lastModified:f.lastModified};
  $('docTitle').textContent=f.name.replace(/\\.pdf$/i,'');
  setStatus('Abrindo PDF e carregando pré-análise...');
  const bytes=new Uint8Array(await f.arrayBuffer());
  const profilePromise=resolveDocumentProfile(bytes);
  pdf=await pdfjsLib.getDocument({data:bytes}).promise;
  await profilePromise;
  if(activeDocProfile){$('docTitle').textContent=activeDocProfile.title;setBuffer('livro reconhecido • mapa de leitura pronto',true);setStatus(`Pré-análise carregada: ${activeDocProfile.chapters?.length||0} capítulos • ${activeDocProfile.glossaryTerms?.length||0}+ termos`);}
  page=1;pendingSentenceIndex=null;
  restoreProgress();
'''
if old_file not in b: raise SystemExit('file handler not found')
b=b.replace(old_file,new_file,1)
browser.write_text(b,encoding='utf-8')

index=root/'index.html'
i=index.read_text(encoding='utf-8-sig')
module=re.search(r'(<script type="module">)(.*?)(</script>)',i,re.S)
if not module: raise SystemExit('inline module not found')
i=i[:module.start(2)]+'\n'+b.strip()+'\n'+i[module.end(2):]
index.write_text(i,encoding='utf-8')
print('SERVER_BROWSER_INDEX_PATCHED')
