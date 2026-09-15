from pathlib import Path
import re
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8-sig')
if 'import urllib.parse' not in s:
    s=s.replace('import urllib.request\n','import urllib.request\nimport urllib.parse\nimport shutil\n',1)
san='''def sanitize_document_text(text:str,doc_id:str=""):
    if not doc_id: return text
    out=[]
    for raw in (text or "").splitlines():
        line=" ".join(raw.split()).strip()
        if not line: continue
        if re.fullmatch(r"\\d{1,4}",line): continue
        if doc_id=="kotler-keller-marketing-management-15e-global" and re.search(r"(?:A|M)\\d{2}_KOTL\\S*\\.indd",line,re.I): continue
        low=line.lower()
        if low.startswith(("mymarketinglab","improve your grade","source: ©","source: ")): continue
        if doc_id=="zikmund-marketing-research-4e-asia-pacific" and low.startswith(("coursemate online study tools","courtesy of qualtrics.com","survey this!")): continue
        if re.fullmatch(r"(?:www\\.|https?://)\\S+",line,re.I): continue
        out.append(line)
    return "\\n".join(out)

'''
s,n=re.subn(r'def sanitize_document_text\(.*?\n(?=def normalize_speech_text)',lambda m:san,s,flags=re.S)
if n!=1: raise SystemExit(f'sanitize_replace={n}')
speech='''def normalize_speech_text(text:str,doc_id:str=""):
    text=" ".join((text or "").split())
    if doc_id=="kotler-keller-marketing-management-15e-global":
        text=re.sub(r"\\bPhilip Kotler\\b","Fílip Kótler",text,flags=re.I)
        text=re.sub(r"\\bKevin Lane Keller\\b","Kévin Leine Kéler",text,flags=re.I)
        text=re.sub(r"\\bKotler\\b","Kótler",text)
        text=re.sub(r"\\bKeller\\b","Kéler",text)
    profile=KNOWN_BY_ID.get(doc_id)
    if profile:
        for token,spoken in sorted((profile.get("speechTerms") or {}).items(),key=lambda kv:-len(kv[0])):
            text=re.sub(rf"(?<!\\w){re.escape(token)}(?!\\w)",spoken,text,flags=re.I)
    for token,spoken in sorted(SPEECH_EXCEPTIONS.items(),key=lambda kv:-len(kv[0])):
        text=re.sub(rf"(?<!\\w){re.escape(token)}(?!\\w)",spoken,text,flags=re.I)
    text=re.sub(r"(\\d+(?:[\\.,]\\d+)?)\\s*%",r"\\1 por cento",text)
    def spell(m):
        token=m.group(0)
        if token in WORD_ACRONYMS:return token
        return " ".join(PT_LETTERS.get(ch,ch) for ch in token)
    text=re.sub(r"\\b[A-Z]{2,5}\\b",spell,text)
    return text

'''
s,n=re.subn(r'def normalize_speech_text\(.*?\n(?=def translation_cache_path)',lambda m:speech,s,flags=re.S)
if n!=1: raise SystemExit(f'speech_replace={n}')
old='''    profile_note = ""
    if doc_id == "kotler-keller-marketing-management-15e-global":
        profile_note = "This is Philip Kotler and Kevin Lane Keller, Marketing Management, 15th Global Edition. Use natural Brazilian marketing/business vocabulary, preserve proper names and brand names, and keep terminology consistent across pages."
'''
new='''    profile_note = ""
    profile=KNOWN_BY_ID.get(doc_id)
    if profile:
        authors=", ".join(profile.get("authors") or [])
        profile_note=f"This is {profile.get('title','a business textbook')} by {authors}. Use natural Brazilian academic/business vocabulary, preserve proper names, statistical notation and brand/software names, and keep terminology consistent across pages."
'''
if old not in s: raise SystemExit('context profile note not found')
s=s.replace(old,new,1)
helpers='''def public_library():
    items=[]
    for profile in KNOWN_BY_ID.values():
        filename=Path(str(profile.get("libraryFile", ""))).name
        fp=LIBRARY_ROOT/filename if filename else None
        items.append({
            "id":profile.get("id"),"title":profile.get("title"),"edition":profile.get("edition",""),
            "authors":profile.get("authors",[]),"description":profile.get("description",""),
            "sha256":profile.get("sha256"),"size":profile.get("size",0),"pageCount":profile.get("pageCount",0),
            "available":bool(fp and fp.exists()),"warmSentences":profile.get("warmSentences",4),
            "prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[])
        })
    return items

def library_path_for(book_id):
    profile=KNOWN_BY_ID.get(book_id)
    if not profile:return None
    filename=Path(str(profile.get("libraryFile", ""))).name
    if not filename:return None
    fp=(LIBRARY_ROOT/filename).resolve()
    try: fp.relative_to(LIBRARY_ROOT.resolve())
    except ValueError:return None
    return fp if fp.exists() else None

'''
if 'def public_library():' not in s:
    s=s.replace('class Handler(BaseHTTPRequestHandler):\n',helpers+'class Handler(BaseHTTPRequestHandler):\n',1)
route='''        if path == "/api/library":
            return self.send_json(200, {"books": public_library()})
        if path.startswith("/api/library/book/"):
            book_id=urllib.parse.unquote(path.split("/api/library/book/",1)[1])
            fp=library_path_for(book_id)
            if not fp:return self.send_json(404,{"error":"book_not_available"})
            size=fp.stat().st_size
            self.send_response(200);self.send_header("Content-Type","application/pdf");self.send_header("Content-Length",str(size));self.send_header("Cache-Control","public, max-age=86400");self.end_headers()
            with fp.open("rb") as src:shutil.copyfileobj(src,self.wfile,1024*1024)
            return
'''
if 'if path == "/api/library":' not in s:
    marker='        if path.endswith("app-v2.mjs"):\n'
    if marker not in s:raise SystemExit('app route marker not found')
    s=s.replace(marker,route+marker,1)
p.write_text(s,encoding='utf-8')
print('SERVER_LIBRARY_PATCHED')