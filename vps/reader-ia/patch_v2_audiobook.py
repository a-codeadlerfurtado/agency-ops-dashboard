from pathlib import Path
p=Path('index.html');s=p.read_text(encoding='utf-8')
s=s.replace("let bookAnalysis={ready:false,repeated:new Set(),chapters:[]},analysisRunning=false;","let bookAnalysis={ready:false,repeated:new Set(),chapters:[]},analysisRunning=false,lastOffsetPersist=0;",1)
s=s.replace("  pendingSentenceIndex=null;\n  const host=$('translation');","  pendingSentenceIndex=null;currentSentenceOffset=pendingSentenceOffset||0;pendingSentenceOffset=0;\n  const host=$('translation');",1)
s=s.replace("  pendingSentenceIndex=null;\n  const host=$('translation');host.innerHTML='';","  pendingSentenceIndex=null;currentSentenceOffset=pendingSentenceOffset||0;pendingSentenceOffset=0;\n  const host=$('translation');host.innerHTML='';",1)
p.write_text(s,encoding='utf-8')
print('resume offset state patched')
