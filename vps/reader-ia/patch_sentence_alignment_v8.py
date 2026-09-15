from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8-sig')
old="""def sentence_units(text: str):
    text = re.sub(r'\\s+', ' ', (text or '').strip())
    if not text:
        return []
    return [x.strip() for x in re.findall(r'[^.!?…]+(?:[.!?…]+(?:[\\\"”’\\)\\]]+)?(?=\\s|$)|$)', text) if x.strip()]
"""
new="""def sentence_units(text: str):
    units=[]
    for raw in (text or '').splitlines():
        line=re.sub(r'[ \\t]+',' ',raw).strip()
        if not line: continue
        found=[x.strip() for x in re.findall(r'[^.!?…]+(?:[.!?…]+(?:[\\\"”’\\)\\]]+)?(?=\\s|$)|$)',line) if x.strip()]
        units.extend(found or [line])
    return units

def preserve_terminal_punctuation(source: str, target: str):
    source=(source or '').strip(); target=(target or '').strip()
    if not target: return target
    sm=re.search(r'([.!?…]+)[\\\"”’\\)\\]]*$',source)
    tm=re.search(r'([.!?…]+)([\\\"”’\\)\\]]*)$',target)
    if not sm:
        return re.sub(r'[.!?…]+([\\\"”’\\)\\]]*)$',r'\\1',target).rstrip()
    mark=sm.group(1)
    if tm: return target[:tm.start(1)]+mark+tm.group(2)
    return target+mark
"""
assert old in s, 'sentence_units block not found'
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('SENTENCE_UNITS_OK')