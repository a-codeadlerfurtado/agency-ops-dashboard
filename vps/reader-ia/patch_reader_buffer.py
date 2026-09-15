from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("let pdf=null,page=1,fileMeta=null,renderToken=0;", "let pdf=null,page=1,fileMeta=null,renderToken=0,pageLoadToken=0,preloadGeneration=0;")
s=s.replace("const audioCache=new Map(),audioPending=new Map();\nconst pageTextCache=new Map(),translationCache=new Map();", "const audioCache=new Map(),audioPending=new Map();\nconst pageTextCache=new Map(),translationCache=new Map(),translationPending=new Map();")
start=s.index('async function translatePage(n){')
end=s.index('\nasync function renderPdfPage(n){', start)
new_translate=r'''async function translatePage(n,{foreground=true}={}){
  if(translationCache.has(n)) return translationCache.get(n);
  if(translationPending.has(n)) return translationPending.get(n);
  const job=(async()=>{
    const original=await extractPageText(n);
    if(!original){translationCache.set(n,'');return '';}
    let context='';
    if(n>1){try{context=(await extractPageText(n-1)).slice(-2200);}catch{}}
    async function callTranslate(mode,timeoutMs){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const res=await fetch(BASE+'/api/translate',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({text:original,context,source:'en',target:'pt',mode})});
        const data=await res.json();
        if(!res.ok) throw new Error(data.detail||data.error||'Falha na tradução');
        return data.translatedText||'';
      }finally{clearTimeout(timer);}
    }
    let translated='';
    try{translated=await callTranslate('editorial',12000);}
    catch(err){if(foreground)setStatus(`Página ${n}: usando tradução rápida...`);translated=await callTranslate('literal',18000);}
    translated=(translated||'').replace(/\*\*/g,'').replace(/^#{1,6}\s*/gm,'').replace(/`/g,'').trim();
    translationCache.set(n,translated);return translated;
  })();
  translationPending.set(n,job);
  try{return await job;}finally{translationPending.delete(n);}
}

async function warmNextPages(fromPage,count=10){
  const generation=++preloadGeneration;
  const targets=[];
  for(let n=fromPage+1;n<=Math.min(pdf.numPages,fromPage+count);n++) if(!translationCache.has(n)) targets.push(n);
  if(!targets.length){setBuffer(`próximas ${Math.min(count,pdf.numPages-fromPage)} prontas`,true);return;}
  let ready=0;setBuffer(`buffer 0/${targets.length} páginas`);
  for(const n of targets){
    if(generation!==preloadGeneration) return;
    try{await translatePage(n,{foreground:false});ready++;}catch{}
    if(generation!==preloadGeneration) return;
    setBuffer(`buffer ${ready}/${targets.length} páginas`,ready===targets.length);
    await new Promise(r=>setTimeout(r,speaking?700:120));
  }
}'''
s=s[:start]+new_translate+s[end:]
p.write_text(s,encoding='utf-8')
print('translation dedupe + 10-page buffer added')