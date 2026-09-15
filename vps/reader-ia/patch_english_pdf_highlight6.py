from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("  currentSentences=[];sentenceIndex=0;pendingSentenceIndex=null;updateSentenceHighlight();", "  currentSentences=[];currentSourceSentences=[];sourceSentenceRanges=[];pdfTextGeometry=[];sentenceIndex=0;pendingSentenceIndex=null;updateSentenceHighlight();",1)
old="""    if(loadToken!==pageLoadToken || targetPage!==page) return;\n    renderSentences(translated||'Nenhum texto reconhecido nesta página.');"""
new="""    if(loadToken!==pageLoadToken || targetPage!==page) return;\n    const original=await extractPageText(targetPage);\n    if(loadToken!==pageLoadToken || targetPage!==page) return;\n    currentSourceSentences=splitSourceSentences(original);\n    refreshSourceRanges();\n    renderSentences(translated||'Nenhum texto reconhecido nesta página.');"""
if old not in s: raise SystemExit('load translation needle missing')
s=s.replace(old,new,1)
s=s.replace("stopSpeech();pageTextCache.clear();translationCache.clear();", "stopSpeech();pageTextCache.clear();translationCache.clear();pdfTextContentCache.clear();currentSourceSentences=[];sourceSentenceRanges=[];pdfTextGeometry=[];",1)
p.write_text(s,encoding='utf-8')
print('load/source state patched')