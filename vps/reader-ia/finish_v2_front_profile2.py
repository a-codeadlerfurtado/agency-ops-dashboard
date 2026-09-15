from pathlib import Path
p=Path('app-v2.mjs')
s=p.read_text(encoding='utf-8')
old="const bytes=new Uint8Array(await f.arrayBuffer());pdf=await pdfjsLib.getDocument({data:bytes}).promise;page=1;pendingSentenceIndex=null;pendingSentenceOffset=0;restoreProgress();updateAudiobookUi();await loadSavedAnalysis();"
new="const bytes=new Uint8Array(await f.arrayBuffer());pdf=await pdfjsLib.getDocument({data:bytes}).promise;await resolveDocumentProfile(bytes);bookAnalysis={ready:false,repeated:new Set(),chapters:activeDocProfile?.chapters||[]};page=1;pendingSentenceIndex=null;pendingSentenceOffset=0;restoreProgress();updateAudiobookUi();await loadSavedAnalysis();"
if old not in s: raise SystemExit('file load block not found')
s=s.replace(old,new,1)
# Preserve known chapter map when loading learned repeated artifacts.
old2="if(saved?.repeated)bookAnalysis={ready:true,repeated:new Set(saved.repeated),chapters:saved.chapters||[]};"
new2="if(saved?.repeated)bookAnalysis={ready:true,repeated:new Set(saved.repeated),chapters:(activeDocProfile?.chapters?.length?activeDocProfile.chapters:(saved.chapters||[]))};"
s=s.replace(old2,new2,1)
p.write_text(s,encoding='utf-8')
print('profile resolution on PDF open patched')