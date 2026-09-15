from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8')
s=s.replace("let pdfTextGeometry=[],sourceRanges=[];","let pdfTextGeometry=[],sourceRanges=[];\nlet currentHighlightProgress=0,lastHighlightPaint=0;")
old="function updatePdfHighlight(){const layer=$('pdfHighlightLayer');if(!layer)return;layer.innerHTML='';if(!speaking||sentenceIndex<0)return;const refs=sourceRanges[sentenceIndex]||[],boxes=refs.map(tokenGeometry).filter(Boolean);"
new="function updatePdfHighlight(){const layer=$('pdfHighlightLayer');if(!layer)return;layer.innerHTML='';if(!speaking||sentenceIndex<0)return;const allRefs=sourceRanges[sentenceIndex]||[];const progress=Math.max(0,Math.min(.985,currentHighlightProgress||0));const consumed=Math.min(Math.max(0,allRefs.length-1),Math.floor(allRefs.length*progress));const refs=allRefs.slice(consumed),boxes=refs.map(tokenGeometry).filter(Boolean);"
if old not in s: raise SystemExit('highlight marker missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('progressive highlight core patched')