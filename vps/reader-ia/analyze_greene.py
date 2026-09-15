from pathlib import Path
import fitz, hashlib, re, json
PDF=Path(r'C:\Users\Adler\Downloads\_OceanofPDF.com_As_48_leis_do_poder_Portuguese_Edition_-_Roberto_greene.pdf')
OUT=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
doc=fitz.open(PDF)
def titleish(s):
    letters=[c for c in s if c.isalpha()]
    return bool(letters) and sum(c.isupper() for c in letters)/len(letters)>.72
entries=[]
for pno in range(doc.page_count):
    lines=[re.sub(r'\s+',' ',x).strip() for x in doc[pno].get_text('text').splitlines() if x.strip()]
    for i,line in enumerate(lines):
        m=re.fullmatch(r'LEI\s+(\d{1,2})',line,re.I)
        if not m: continue
        parts=[]
        for s in lines[i+1:i+6]:
            if titleish(s): parts.append(s)
            else: break
        entries.append({'number':int(m.group(1)),'title':' '.join(parts),'pdfPage':pno+1})
sha=hashlib.sha256(PDF.read_bytes()).hexdigest()
(OUT/'greene_laws_raw.json').write_text(json.dumps(entries,ensure_ascii=False,indent=2),encoding='utf-8')
(OUT/'greene_meta.json').write_text(json.dumps({'sha256':sha,'size':PDF.stat().st_size,'pageCount':doc.page_count},indent=2),encoding='utf-8')
(OUT/'greene_page153.txt').write_text(doc[152].get_text('text'),encoding='utf-8')
print('laws',len(entries),'sha',sha,'pages',doc.page_count,'size',PDF.stat().st_size)