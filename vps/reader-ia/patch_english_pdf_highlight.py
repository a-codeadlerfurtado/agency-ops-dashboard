from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace(".pdfWrap canvas{display:block;max-width:100%;height:auto}", ".pdfWrap canvas{display:block;max-width:100%;height:auto}.pdfHighlightLayer{position:absolute;inset:0;pointer-events:none;z-index:2}.pdfSourceMark{position:absolute;background:rgba(139,92,246,.24);border-bottom:2px solid rgba(34,211,238,.92);border-radius:3px;box-shadow:0 0 0 1px rgba(139,92,246,.12),0 0 14px rgba(139,92,246,.18)}")
s=s.replace("let speaking=false,paused=false,sentenceIndex=0,currentSentences=[],pendingSentenceIndex=null,pendingVoice=null;", "let speaking=false,paused=false,sentenceIndex=0,currentSentences=[],currentSourceSentences=[],sourceSentenceRanges=[],pdfTextGeometry=[],pendingSentenceIndex=null,pendingVoice=null;")
s=s.replace("const pageTextCache=new Map(),translationCache=new Map(),translationPending=new Map();", "const pageTextCache=new Map(),translationCache=new Map(),translationPending=new Map(),pdfTextContentCache=new Map();")
p.write_text(s,encoding='utf-8')
print('css/state patched')