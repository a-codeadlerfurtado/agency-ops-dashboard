from pathlib import Path
p=Path('app-v2.mjs')
s=p.read_text(encoding='utf-8')
s=s.replace("let pdf=null,page=1,fileMeta=null,renderToken=0,pageLoadToken=0,preloadGeneration=0;","let pdf=null,page=1,fileMeta=null,renderToken=0,pageLoadToken=0,preloadGeneration=0,activeDocHash='',activeDocProfile=null;")
s=s.replace("function documentKey(){return fileMeta?`${fileMeta.name}:${fileMeta.size}:${fileMeta.lastModified||0}`:'';}","function documentKey(){return fileMeta?`${activeDocHash||fileMeta.name}:${fileMeta.size}`:'';}")
anchor="function hashText(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}\n"
insert="""async function sha256Bytes(bytes){const view=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),digest=await crypto.subtle.digest('SHA-256',view);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function resolveDocumentProfile(bytes){activeDocHash=await sha256Bytes(bytes);try{const r=await fetch(BASE+'/api/document-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sha256:activeDocHash,size:fileMeta?.size||0,pageCount:pdf?.numPages||0})});const d=await r.json();activeDocProfile=d?.known?d.profile:null;}catch{activeDocProfile=null;}return activeDocProfile;}
function docId(){return activeDocProfile?.id||'';}
"""
if insert.strip() not in s:s=s.replace(anchor,anchor+insert,1)
s=s.replace("body:JSON.stringify({text:original,context,source:'en',target:'pt',mode})","body:JSON.stringify({text:original,context,source:'en',target:'pt',mode,docId:docId()})")
s=s.replace("body:JSON.stringify({text:spoken,voice,speed:1})","body:JSON.stringify({text:spoken,voice,speed:1,docId:docId()})")
p.write_text(s,encoding='utf-8')
print('front profile/docId wired')