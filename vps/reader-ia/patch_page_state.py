from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old='''async function loadPage(n,{autoplay=false}={}){\n  if(!pdf) return;\n  stopSpeech();\n  page=Math.min(Math.max(1,n),pdf.numPages);'''
new='''async function loadPage(n,{autoplay=false}={}){\n  if(!pdf) return;\n  const loadToken=++pageLoadToken;\n  preloadGeneration++;\n  stopSpeech();\n  currentSentences=[];sentenceIndex=0;pendingSentenceIndex=null;updateSentenceHighlight();\n  page=Math.min(Math.max(1,n),pdf.numPages);'''
assert old in s;s=s.replace(old,new)
old2='''    const translated=await translatePage(page);\n    renderSentences(translated||'Nenhum texto reconhecido nesta página.');\n    setStatus(`Página ${page} pronta • tradução editorial contextualizada`);'''
new2='''    const targetPage=page;\n    const translated=await translatePage(targetPage,{foreground:true});\n    if(loadToken!==pageLoadToken || targetPage!==page) return;\n    renderSentences(translated||'Nenhum texto reconhecido nesta página.');\n    setStatus(`Página ${page} pronta • tradução editorial contextualizada`);'''
assert old2 in s;s=s.replace(old2,new2)
p.write_text(s,encoding='utf-8');print('page race guard added')