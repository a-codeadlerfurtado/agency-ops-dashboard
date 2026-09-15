from pathlib import Path
p=Path('index.html');s=p.read_text(encoding='utf-8')
start=s.index('async function translatePage(n,{foreground=true}={}){')
end=s.index('\nasync function warmNextPages',start)
part1=r'''async function translatePage(n,{foreground=true}={}){
  if(translationCache.has(n)) return translationCache.get(n);
  if(translationPending.has(n)) return translationPending.get(n);
  const job=(async()=>{
    const persistent=`translation:${documentKey()}:${n}`;
    const saved=await dbGet(persistent);
    if(saved?.translatedText){translationCache.set(n,saved.translatedText);pageAlignmentCache.set(n,saved);return saved.translatedText;}
    const original=await extractPageText(n);
    if(!original){translationCache.set(n,'');return '';}
    let context='';
    if(n>1){try{context=(await extractPageText(n-1)).slice(-2600);}catch{}}
    async function callTranslate(mode,timeoutMs){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const res=await fetch(BASE+'/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({text:original,context,source:'en',target:'pt',mode})});
        const data=await res.json();if(!res.ok)throw new Error(data.detail||data.error||'Falha na tradução');return data;
      }finally{clearTimeout(timer);}
    }
'''
part2=r'''    let data;
    try{data=await callTranslate('structured',foreground?14000:24000);}
    catch(err){if(foreground)setStatus(`Página ${n}: usando tradução rápida...`);data=await callTranslate('literal',20000);}
    const translated=String(data.translatedText||'').replace(/\*\*/g,'').replace(/^#{1,6}\s*/gm,'').replace(/`/g,'').trim();
    const record={translatedText:translated,segments:Array.isArray(data.segments)?data.segments:[],engine:data.engine||'unknown',savedAt:Date.now()};
    translationCache.set(n,translated);pageAlignmentCache.set(n,record);dbPut(persistent,record);
    return translated;
  })();
  translationPending.set(n,job);
  try{return await job;}finally{translationPending.delete(n);}
}
'''
s=s[:start]+part1+part2+s[end:]
p.write_text(s,encoding='utf-8')
print('translatePage v2 persistent structured patched')
