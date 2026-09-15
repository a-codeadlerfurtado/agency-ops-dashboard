from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8-sig')
old="""  const res=await fetch(BASE+'/api/translate',{\n    method:'POST',headers:{'Content-Type':'application/json'},\n    body:JSON.stringify({text:original,context,source:'en',target:'pt',mode:'editorial'})\n  });\n  const data=await res.json();\n  if(!res.ok) throw new Error(data.detail||data.error||'Falha na tradução');\n  const translated=data.translatedText||'';\n  translationCache.set(n,translated);\n  return translated;\n"""
new="""  async function callTranslate(mode,timeoutMs){\n    const controller=new AbortController();\n    const timer=setTimeout(()=>controller.abort(),timeoutMs);\n    try{\n      const res=await fetch(BASE+'/api/translate',{\n        method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,\n        body:JSON.stringify({text:original,context,source:'en',target:'pt',mode})\n      });\n      const data=await res.json();\n      if(!res.ok) throw new Error(data.detail||data.error||'Falha na tradução');\n      return data.translatedText||'';\n    }finally{clearTimeout(timer);}\n  }\n  let translated='';\n  try{translated=await callTranslate('editorial',12000);}\n  catch(err){\n    setStatus(`Página ${n}: usando tradução rápida...`);\n    translated=await callTranslate('literal',18000);\n  }\n  translated=(translated||'').replace(/\\*\\*/g,'').replace(/^#{1,6}\\s*/gm,'').replace(/`/g,'').trim();\n  translationCache.set(n,translated);\n  return translated;\n"""
if old not in s:
    raise SystemExit('translate block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('frontend timeout/fallback added')