from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'app-v2.mjs'; s=p.read_text(encoding='utf-8-sig')
s=s.replace("function docId(){return knownBookId||activeDocProfile?.id||'';}","function docId(){return knownBookId||activeDocProfile?.id||'';}\nfunction isNativeBook(){return !!knownBookProfile?.nativeText||String(knownBookProfile?.language||'').toLowerCase().startsWith('pt');}\nfunction updateLanguageUi(){const native=isNativeBook(),el=document.querySelector('.readerHeader .eyebrow');if(el)el.textContent=native?'Leitura original • PT-BR':'Tradução simultânea • EN → PT-BR';}")
s=s.replace("function activateProfile(profile){knownBookProfile=profile||null;knownBookId=String(profile?.id||'');knownBookSha256=String(profile?.sha256||'');activeDocHash=knownBookSha256;activeDocProfile=profile||null;if(Array.isArray(profile?.chapters))bookAnalysis.chapters=profile.chapters;}","function activateProfile(profile){knownBookProfile=profile||null;knownBookId=String(profile?.id||'');knownBookSha256=String(profile?.sha256||'');activeDocHash=knownBookSha256;activeDocProfile=profile||null;if(Array.isArray(profile?.chapters))bookAnalysis.chapters=profile.chapters;updateLanguageUi();}")
s=s.replace("function fallbackSegments(source,target){", "function nativeRecordFromText(original){const parts=splitSentences(original,'pt-BR');return{sourceText:original,translatedText:original,segments:parts.map((x,i)=>({id:i,source:x,target:x})),engine:'native-ptbr',savedAt:Date.now()};}\nfunction fallbackSegments(source,target){")
old="const original=await extractPageText(n);if(!original){const empty={sourceText:'',translatedText:'',segments:[]};translationCache.set(n,empty);return empty;}let context='';"
new="const original=await extractPageText(n);if(!original){const empty={sourceText:'',translatedText:'',segments:[]};translationCache.set(n,empty);return empty;}if(isNativeBook()){const record=nativeRecordFromText(original);translationCache.set(n,record);dbPut(key,record);return record;}let context='';"
if old not in s: raise SystemExit('translate marker missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8-sig')
print('app patched')