from pathlib import Path
p=Path('server.py')
s=p.read_text(encoding='utf-8')
if 'from concurrent.futures import ThreadPoolExecutor' not in s:
    s=s.replace('from pathlib import Path\n','from pathlib import Path\nfrom concurrent.futures import ThreadPoolExecutor\n',1)
s=s.replace('f"v5|{TRANSLATION_MODEL}|','f"v6|{TRANSLATION_MODEL}|',1)
anchor='def structured_translation(text: str, context: str = "", doc_id: str = ""):\n'
helpers='''def semantic_chunks(text: str, limit: int = 1150):
    units=sentence_units(text)
    if not units:return []
    chunks=[];current=[];size=0
    for unit in units:
        if current and size+len(unit)+1>limit:
            chunks.append(" ".join(current));current=[];size=0
        current.append(unit);size+=len(unit)+1
    if current:chunks.append(" ".join(current))
    return chunks

def polish_fast_translation(text: str, doc_id: str = ""):
    out=" ".join((text or "").split())
    out=re.sub(r"\\b(\\d+)a edição\\b",r"\\1ª edição",out,flags=re.I)
    out=re.sub(r"\\b(\\d+)o capítulo\\b",r"\\1º capítulo",out,flags=re.I)
    if doc_id=="kotler-keller-marketing-management-15e-global":
        out=re.sub(r"\\bMarketing Management\\b","Administração de Marketing",out,flags=re.I)
        out=re.sub(r"\\bMarketing Insight\\b","Insight de Marketing",out,flags=re.I)
        out=re.sub(r"\\bMarketing Memo\\b","Memorando de Marketing",out,flags=re.I)
    return out.strip()

def fast_structured_translation(text: str, source: str, target: str, doc_id: str = ""):
    chunks=semantic_chunks(text)
    if not chunks:return "",[]
    workers=min(4,len(chunks))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        translated=list(pool.map(lambda c: translate_chunk(c,source,target),chunks))
    all_segments=[];parts=[]
    for src_chunk,dst_chunk in zip(chunks,translated):
        dst_chunk=polish_fast_translation(dst_chunk,doc_id);parts.append(dst_chunk)
        for seg in align_translation(src_chunk,dst_chunk):
            seg["id"]=len(all_segments);all_segments.append(seg)
    return " ".join(parts).strip(),all_segments

'''
if 'def fast_structured_translation' not in s:s=s.replace(anchor,helpers+anchor,1)
p.write_text(s,encoding='utf-8')
print('fast structured translation helpers added')