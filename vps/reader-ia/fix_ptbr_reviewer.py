from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8-sig'); a=s.index('def ptbr_surface_polish'); b=s.index('def fast_structured_translation',a)
block=r'''def fix_concessive_subjunctive(text: str):
    forms={"est\u00e1":"esteja","est\u00e3o":"estejam","\u00e9":"seja","s\u00e3o":"sejam","tem":"tenha","t\u00eam":"tenham","pode":"possa","podem":"possam","faz":"fa\u00e7a","fazem":"fa\u00e7am","continua":"continue","continuam":"continuem","permanece":"permane\u00e7a","permanecem":"permane\u00e7am"}
    pat=re.compile(r"\b(mesmo que|embora|ainda que)\b([^,.!?;]{0,220}?)\b(est\u00e1|est\u00e3o|\u00e9|s\u00e3o|tem|t\u00eam|pode|podem|faz|fazem|continua|continuam|permanece|permanecem)\b",re.I)
    def repl(m):
        old=m.group(3); new=forms.get(old.lower(),old); return m.group(1)+m.group(2)+(new.capitalize() if old[:1].isupper() else new)
    return pat.sub(repl,text)

def ptbr_surface_polish(text: str):
    out=" ".join((text or "").split())
    pairs=((r"\bactualiza\u00e7\u00e3o\b","atualiza\u00e7\u00e3o"),(r"\bactualiza\u00e7\u00f5es\b","atualiza\u00e7\u00f5es"),(r"\bactualizado\b","atualizado"),(r"\bactualizada\b","atualizada"),(r"\bactualizados\b","atualizados"),(r"\bactualizadas\b","atualizadas"),(r"\bobjectivo\b","objetivo"),(r"\bobjectivos\b","objetivos"),(r"\bprojecto\b","projeto"),(r"\bprojectos\b","projetos"),(r"\bcontacto\b","contato"),(r"\bcontactos\b","contatos"),(r"\bequipa\b","equipe"),(r"\bficheiro\b","arquivo"),(r"\becr\u00e3\b","tela"),(r"\bse for caso disso\b","quando apropriado"))
    for pat,repl in pairs: out=re.sub(pat,repl,out,flags=re.I)
    return fix_concessive_subjunctive(out).strip()

def request_form_json(url: str, fields: dict, timeout: float=4):
    data=urllib.parse.urlencode(fields).encode("utf-8"); req=urllib.request.Request(url,data=data,headers={"Content-Type":"application/x-www-form-urlencoded"},method="POST")
    with urllib.request.urlopen(req,timeout=timeout) as response:return json.loads(response.read().decode("utf-8"))

def grammar_findings(text: str):
    try:
        data=request_form_json(f"{GRAMMAR_URL}/v2/check",{"language":"pt-BR","level":"picky","text":text},3.5); return [m for m in data.get("matches",[]) if str(m.get("rule",{}).get("issueType","")).lower()=="grammar"]
    except Exception as exc: print(f"grammar_check_failed:{exc}"); return []
'''
s=s[:a]+block+s[b:]; p.write_text(s,encoding='utf-8'); print('review block replaced')