from pathlib import Path
p=Path('app-v2.mjs')
s=p.read_text(encoding='utf-8')
s=s.replace("function docId(){return activeDocProfile?.id||'';}","function docId(){return knownBookId||activeDocProfile?.id||'';}")
old="if(r.ok&&d.known&&d.profile){knownBookProfile=d.profile;knownBookId=String(d.profile.id||'');if(Array.isArray(d.profile.chapters)&&d.profile.chapters.length)bookAnalysis.chapters=d.profile.chapters;return d.profile;}"
new="if(r.ok&&d.known&&d.profile){knownBookProfile=d.profile;knownBookId=String(d.profile.id||'');activeDocHash=knownBookSha256;activeDocProfile=d.profile;if(Array.isArray(d.profile.chapters)&&d.profile.chapters.length)bookAnalysis.chapters=d.profile.chapters;return d.profile;}"
if old not in s: raise SystemExit('detect profile block not found')
s=s.replace(old,new,1)
s=s.replace("if(saved?.repeated)bookAnalysis={ready:true,repeated:new Set(saved.repeated),chapters:saved.chapters||[]};","if(saved?.repeated)bookAnalysis={ready:true,repeated:new Set(saved.repeated),chapters:(knownBookProfile?.chapters?.length?knownBookProfile.chapters:(saved.chapters||[]))};")
s=s.replace("const sampleCount=Math.min(pdf.numPages,28),counts=new Map(),chapters=[];","const sampleCount=Math.min(pdf.numPages,28),counts=new Map(),chapters=[...(knownBookProfile?.chapters||[])];")
p.write_text(s,encoding='utf-8')
print('known profile state merged')