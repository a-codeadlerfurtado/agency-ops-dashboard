from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="""    const targetPage=page;
    const currentTranslation=translatePage(targetPage,{foreground:true});
    setTimeout(()=>{if(loadToken===pageLoadToken) warmNextPages(targetPage,10);},250);
    const translated=await currentTranslation;
    if(loadToken!==pageLoadToken || targetPage!==page) return;
    renderSentences(translated||'Nenhum texto reconhecido nesta página.');
    setStatus(`Página ${page} pronta • tradução editorial contextualizada`);
    saveProgress();
    if(autoplay && translated && loadToken===pageLoadToken) startSpeech();
"""
new="""    const targetPage=page;
    setBuffer('prioridade: página atual');
    const translated=await translatePage(targetPage,{foreground:true});
    if(loadToken!==pageLoadToken || targetPage!==page) return;
    renderSentences(translated||'Nenhum texto reconhecido nesta página.');
    setStatus(`Página ${page} pronta • tradução editorial contextualizada`);
    setBuffer('página atual pronta • preparando próximas 10',true);
    saveProgress();
    if(autoplay && translated && loadToken===pageLoadToken) startSpeech();
    if(loadToken===pageLoadToken) setTimeout(()=>warmNextPages(targetPage,10),80);
"""
if old not in s: raise SystemExit('loadPage priority block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('current page strict priority patched')