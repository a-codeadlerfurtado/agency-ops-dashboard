from pathlib import Path
p=Path('index.html');s=p.read_text(encoding='utf-8')
anchor='function cleanPdfText(text){\n'
insert=r'''function normalizedArtifactLine(line){return String(line||'').toLowerCase().replace(/\d+/g,'#').replace(/[^a-zà-ÿ#]+/gi,' ').replace(/\s+/g,' ').trim();}
async function rawPageLines(n){
  const pg=await pdf.getPage(n),content=pdfTextContentCache.get(n)||await pg.getTextContent();pdfTextContentCache.set(n,content);
  const lines=[];let line='',lastY=null;
  for(const item of content.items){const y=item.transform?.[5];if(lastY!==null&&Math.abs(y-lastY)>6){if(line.trim())lines.push(line.replace(/\s+/g,' ').trim());line='';}line+=(line?' ':'')+item.str;lastY=y;}
  if(line.trim())lines.push(line.replace(/\s+/g,' ').trim());return lines;
}
async function analyzeDocumentBackground(){
  if(!pdf||analysisRunning||bookAnalysis.ready)return;analysisRunning=true;
  try{
    const saved=await dbGet(`analysis:${documentKey()}`);
    if(saved?.repeated){bookAnalysis={ready:true,repeated:new Set(saved.repeated),chapters:saved.chapters||[]};return;}
    const max=Math.min(pdf.numPages,28),sample=[...new Set([...Array(max).keys()].map(i=>i+1).concat([page]))];
    const counts=new Map(),chapters=[];
    for(const n of sample){const lines=await rawPageLines(n);for(const line of lines){const key=normalizedArtifactLine(line);if(key&&line.length<120)counts.set(key,(counts.get(key)||0)+1);if(/^(chapter|part|preface|introduction|capítulo|parte)\b/i.test(line)&&line.length<140)chapters.push({page:n,title:line});}}
    const repeated=[...counts.entries()].filter(([,c])=>c>=3).map(([k])=>k);
    bookAnalysis={ready:true,repeated:new Set(repeated),chapters};dbPut(`analysis:${documentKey()}`,{repeated,chapters,savedAt:Date.now()});
  }catch(e){console.warn('book_analysis_failed',e);}finally{analysisRunning=false;}
}
'''
if anchor not in s: raise SystemExit('cleanPdfText anchor missing')
s=s.replace(anchor,insert+anchor,1)
p.write_text(s,encoding='utf-8')
print('book analysis functions added')

p=Path('index.html');s=p.read_text(encoding='utf-8')
old="""  const kept=lines.filter(line=>{\n    if(/^(?:page|página)?\\s*\\d+(?:\\s*(?:of|de)\\s*\\d+)?$/i.test(line)) return false;"""
new="""  const kept=lines.filter(line=>{\n    if(bookAnalysis.ready&&bookAnalysis.repeated.has(normalizedArtifactLine(line))) return false;\n    if(/^(?:page|página)?\\s*\\d+(?:\\s*(?:of|de)\\s*\\d+)?$/i.test(line)) return false;"""
if old not in s: raise SystemExit('clean filter block missing')
s=s.replace(old,new,1)
old2="""    saveProgress();\n    if(autoplay && translated && loadToken===pageLoadToken) startSpeech();\n    if(loadToken===pageLoadToken) setTimeout(()=>warmNextPages(targetPage,10),80);"""
new2="""    saveProgress();\n    if(autoplay && translated && loadToken===pageLoadToken) startSpeech();\n    if(loadToken===pageLoadToken){setTimeout(()=>analyzeDocumentBackground(),120);setTimeout(()=>warmNextPages(targetPage,10),180);}"""
if old2 not in s: raise SystemExit('load scheduling block missing')
s=s.replace(old2,new2,1)
p.write_text(s,encoding='utf-8')
print('artifact cleaning + post-current analysis scheduling patched')
