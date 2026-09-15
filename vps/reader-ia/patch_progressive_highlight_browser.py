from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8')
old="u.onstart=updateHighlights;u.onend=()=>{if(!speaking)return;sentenceIndex++;currentSentenceOffset=0;currentHighlightProgress=0;saveProgress();"
new="u.onstart=()=>{currentHighlightProgress=0;updateHighlights();};u.onboundary=e=>{if(!speaking||paused)return;const n=Math.max(1,u.text.length),i=Math.max(0,Number(e.charIndex)||0);currentHighlightProgress=Math.min(.985,i/n);updatePdfHighlight();};u.onend=()=>{if(!speaking)return;sentenceIndex++;currentSentenceOffset=0;currentHighlightProgress=0;saveProgress();"
if old not in s: raise SystemExit('browser speech marker missing')
s=s.replace(old,new,1)
s=s.replace("currentSegments=[];sourceRanges=[];pdfTextGeometry=[];page=", "currentSegments=[];sourceRanges=[];pdfTextGeometry=[];currentHighlightProgress=0;page=",1)
p.write_text(s,encoding='utf-8')
print('browser + page reset patched')