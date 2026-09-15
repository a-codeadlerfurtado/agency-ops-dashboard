from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8'); mark='def fast_structured_translation'
block=r'''def apply_grammar_suggestions(text: str, issues):
    out=text
    for m in sorted(issues,key=lambda x:int(x.get("offset",0)),reverse=True):
        reps=m.get("replacements") or []
        if not reps: continue
        value=str(reps[0].get("value","")).strip(); off=int(m.get("offset",0)); length=int(m.get("length",0))
        if value and 0<=off<=len(out) and off+length<=len(out): out=out[:off]+value+out[off+length:]
    return out

def suspicious_ptbr(text: str):
    return bool(re.search(r"\b(mesmo que|embora|ainda que)\b[^,.!?;]{0,220}\b(est\u00e1|est\u00e3o|\u00e9|s\u00e3o|tem|t\u00eam|pode|podem|faz|fazem|continua|continuam|permanece|permanecem)\b|\b(actualiz|objectiv|projecto|contacto|equipa|ficheiro)\w*",text or "",re.I))

def review_ptbr_segments(segments, doc_id: str=""):
    reviewed=[]; flagged=[]
    for i,seg in enumerate(segments or []):
        item=dict(seg); base=ptbr_surface_polish(polish_fast_translation(str(item.get("target","")),doc_id)); issues=grammar_findings(base); base=apply_grammar_suggestions(base,issues); base=ptbr_surface_polish(base); item["target"]=base; reviewed.append(item)
        if issues or suspicious_ptbr(base): flagged.append((i,item,"; ".join(str(x.get("message","")) for x in issues[:4])))
    if flagged and model_available(QWEN_URL,PTBR_REVIEW_MODEL):
        blocks="\n\n".join(f"[U{i}]\nEN: {seg.get('source','')}\nPT: {seg.get('target','')}\nCHECK: {msg or 'concordancia, regencia, modo verbal e naturalidade pt-BR'}" for i,seg,msg in flagged)
        prompt="Revise o portugues brasileiro dos blocos. Corrija apenas gramatica, concordancia, regencia, modo/tempo verbal e construcoes literais. Preserve rigorosamente o sentido do ingles, numeros, nomes e pontuacao final. Use pt-BR, nunca portugues europeu. Retorne apenas [U#] texto revisado.\n\n"+blocks
        try:
            data=request_json(f"{QWEN_URL}/api/generate",{"model":PTBR_REVIEW_MODEL,"prompt":prompt,"stream":False,"keep_alive":"30m","options":{"temperature":0,"num_ctx":4096,"num_predict":1200}},timeout=10); result=str(data.get("response","")).strip(); found={int(m.group(1)):" ".join(m.group(2).split()).strip() for m in re.finditer(r"(?s)\[U(\d+)\]\s*(.*?)(?=\n\s*\[U\d+\]|\Z)",result)}
            for i,seg,_ in flagged:
                if found.get(i): seg["target"]=ptbr_surface_polish(preserve_terminal_punctuation(seg.get("source",""),found[i]))
        except Exception as exc: print(f"ptbr_llm_review_failed:{exc}")
    for seg in reviewed: seg["target"]=preserve_terminal_punctuation(seg.get("source",""),ptbr_surface_polish(seg.get("target","")))
    return reviewed

'''
if 'def review_ptbr_segments' not in s: s=s.replace(mark,block+mark,1)
p.write_text(s,encoding='utf-8'); print('review pipeline inserted', 'def review_ptbr_segments' in s)