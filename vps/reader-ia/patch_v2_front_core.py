from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace('.btn.playing{background:#3f1d2e;border-color:#be4567}', '.btn.playing{background:#3f1d2e;border-color:#be4567}.btn.modeOn{background:#12352e;border-color:#2f9f79;color:#b8ffe5}',1)
s=s.replace('    <button class="btn primary" id="play">▶ Ouvir</button>', '    <button class="btn" id="audiobook">🎧 Audiobook</button>\n    <button class="btn primary" id="play">▶ Ouvir</button>',1)
old='''let speaking=false,paused=false,sentenceIndex=0,currentSentences=[],currentSourceSentences=[],sourceSentenceRanges=[],pdfTextGeometry=[],pendingSentenceIndex=null,pendingVoice=null;'''
new='''let speaking=false,paused=false,sentenceIndex=0,currentSentences=[],currentSourceSentences=[],sourceSentenceRanges=[],pdfTextGeometry=[],pendingSentenceIndex=null,pendingSentenceOffset=0,pendingVoice=null;\nlet currentSegments=[],currentSentenceOffset=0,audiobookMode=localStorage.getItem('readerpro:audiobook')==='1',wakeLock=null;\nlet bookAnalysis={ready:false,repeated:new Set(),chapters:[]},analysisRunning=false;'''
if old not in s: raise SystemExit('state line missing')
s=s.replace(old,new,1)
s=s.replace('const pageTextCache=new Map(),translationCache=new Map(),translationPending=new Map(),pdfTextContentCache=new Map();','const pageTextCache=new Map(),translationCache=new Map(),translationPending=new Map(),pageAlignmentCache=new Map(),pdfTextContentCache=new Map();',1)
p.write_text(s,encoding='utf-8')
print('front v2 ui/state patched')

p=Path('index.html');s=p.read_text(encoding='utf-8')
anchor='function bookKey(){return fileMeta?`reader:${fileMeta.name}:${fileMeta.size}`:null;}\n'
insert=r'''const dbPromise=new Promise((resolve,reject)=>{
  const req=indexedDB.open('readerpro-v2',1);
  req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});
async function dbGet(key){try{const db=await dbPromise;return await new Promise((r,j)=>{const q=db.transaction('kv').objectStore('kv').get(key);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});}catch{return undefined;}}
async function dbPut(key,value){try{const db=await dbPromise;await new Promise((r,j)=>{const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(value,key);tx.oncomplete=r;tx.onerror=()=>j(tx.error);});}catch{}}
function hashText(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}
function documentKey(){return fileMeta?`${fileMeta.name}:${fileMeta.size}:${fileMeta.lastModified||0}`:'';}
'''
if anchor not in s: raise SystemExit('bookKey anchor missing')
s=s.replace(anchor,insert+'\nfunction bookKey(){return fileMeta?`reader:${fileMeta.name}:${fileMeta.size}:${fileMeta.lastModified||0}`:null;}\n',1)
p.write_text(s,encoding='utf-8')
print('indexeddb helpers patched')

p=Path('index.html');s=p.read_text(encoding='utf-8')
s=s.replace("localStorage.setItem(bookKey(),JSON.stringify({page,sentenceIndex,rate:$('rate').value,voice:$('voice').value}));","localStorage.setItem(bookKey(),JSON.stringify({page,sentenceIndex,sentenceOffset:currentSentenceOffset,rate:$('rate').value,voice:$('voice').value,audiobook:audiobookMode}));",1)
old="""    if(Number.isInteger(p.sentenceIndex)) pendingSentenceIndex=p.sentenceIndex;\n    if(p.rate) $('rate').value=p.rate;\n    if(p.voice) pendingVoice=p.voice;"""
new="""    if(Number.isInteger(p.sentenceIndex)) pendingSentenceIndex=p.sentenceIndex;\n    if(Number.isFinite(p.sentenceOffset)) pendingSentenceOffset=Math.max(0,p.sentenceOffset);\n    if(p.rate) $('rate').value=p.rate;\n    if(p.voice) pendingVoice=p.voice;\n    if(typeof p.audiobook==='boolean') audiobookMode=p.audiobook;"""
if old not in s: raise SystemExit('restore block missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('progress seconds patched')
