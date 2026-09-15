from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py'); s=p.read_text(encoding='utf-8')
a=s.index('def review_ptbr_segments'); b=s.index('def fast_structured_translation',a)
block=r'''def review_ptbr_segments(segments, doc_id: str=""):
    reviewed=[]
    for seg in segments or []:
        item=dict(seg); item["target"]=ptbr_surface_polish(polish_fast_translation(str(item.get("target","")),doc_id)); reviewed.append(item)
    if not reviewed:return reviewed
    with ThreadPoolExecutor(max_workers=min(8,len(reviewed))) as pool: findings=list(pool.map(lambda x: grammar_findings(x.get("target","")),reviewed))
    flagged=[]
    for i,(seg,issues) in enumerate(zip(reviewed,findings)):
        seg["target"]=ptbr_surface_polish(apply_grammar_suggestions(seg["target"],issues))
        unsafe=any(not (m.get("replacements") or []) for m in issues)
        if suspicious_ptbr(seg["target"]) or unsafe: flagged.append((i,seg))
    if flagged and model_available(QWEN_URL,PTBR_REVIEW_MODEL):
        blocks="\n\n".join(f"[U{i}]\nEN: {seg.get('source','')}\nPT: {seg.get('target','')}" for i,seg in flagged)
        prompt="Revise apenas gramatica, concordancia, regencia, modo/tempo verbal e naturalidade em portugues brasileiro. Preserve exatamente o sentido do ingles, numeros, nomes e pontuacao final. Nao resuma nem acrescente informacao. Retorne somente [U#] texto revisado.\n\n"+blocks
        try:
            data=request_json(f"{QWEN_URL}/api/generate",{"model":PTBR_REVIEW_MODEL,"prompt":prompt,"stream":False,"keep_alive":"30m","options":{"temperature":0,"num_ctx":4096,"num_predict":900}},timeout=8); result=str(data.get("response","")).strip(); found={int(m.group(1)):" ".join(m.group(2).split()).strip() for m in re.finditer(r"(?s)\[U(\d+)\]\s*(.*?)(?=\n\s*\[U\d+\]|\Z)",result)}
            for i,seg in flagged:
                if found.get(i): seg["target"]=ptbr_surface_polish(preserve_terminal_punctuation(seg.get("source",""),found[i]))
        except Exception as exc: print(f"ptbr_llm_review_failed:{exc}")
    for seg in reviewed: seg["target"]=preserve_terminal_punctuation(seg.get("source",""),ptbr_surface_polish(seg.get("target","")))
    return reviewed

'''
s=s[:a]+block+s[b:]; p.write_text(s,encoding='utf-8'); print('parallel ptbr review applied')