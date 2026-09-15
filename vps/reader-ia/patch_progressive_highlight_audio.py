from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8')
old="if(active){currentSentenceOffset=Math.max(0,active.offset+(now-active.start)*active.rate);if(active.idx!==sentenceIndex){sentenceIndex=active.idx;currentSentenceOffset=active.offset||0;updateHighlights();}if(performance.now()-lastOffsetPersist>1500){"
new="if(active){currentSentenceOffset=Math.max(0,active.offset+(now-active.start)*active.rate);const total=Math.max(.05,active.source?.buffer?.duration||0);currentHighlightProgress=Math.max(0,Math.min(.985,currentSentenceOffset/total));if(active.idx!==sentenceIndex){sentenceIndex=active.idx;currentSentenceOffset=active.offset||0;currentHighlightProgress=Math.max(0,Math.min(.985,currentSentenceOffset/total));updateHighlights();}else if(performance.now()-lastHighlightPaint>85){lastHighlightPaint=performance.now();updatePdfHighlight();}if(performance.now()-lastOffsetPersist>1500){"
if old not in s: raise SystemExit('audio loop marker missing')
s=s.replace(old,new,1)
for old,new in [("sentenceIndex=i;currentSentenceOffset=0;startSpeech();","sentenceIndex=i;currentSentenceOffset=0;currentHighlightProgress=0;startSpeech();"),("sentenceIndex++;currentSentenceOffset=0;saveProgress();","sentenceIndex++;currentSentenceOffset=0;currentHighlightProgress=0;saveProgress();")]:
    s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('audio progress patched')