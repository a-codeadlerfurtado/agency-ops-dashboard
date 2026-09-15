from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("let audioContext=null,currentSource=null,currentBuffer=null;\nconst audioCache=new Map(),audioPending=new Map();", "let audioContext=null,currentSource=null,currentBuffer=null;\nlet audioTimeline=[],audioScheduleGeneration=0,audioFillRunning=false,highlightRaf=0;\nconst audioCache=new Map(),audioPending=new Map(),decodedAudioCache=new Map();")
old="""function splitSentences(text){
  return (text.match(/[^.!?…]+(?:[.!?…]+|$)/g)||[text]).map(s=>s.trim()).filter(Boolean);
}"""
new="""function splitSentences(text){
  const units=[];
  for(const raw of String(text||'').split(/\\n+/)){
    const line=raw.replace(/\\s+/g,' ').trim();
    if(!line) continue;
    if(line.length<=95 && !/[.!?…:]$/.test(line)){units.push(line);continue;}
    const parts=line.match(/[^.!?…]+(?:[.!?…]+(?=\\s|$)|$)/g)||[line];
    for(const part of parts){const clean=part.trim();if(clean) units.push(clean);}
  }
  return units;
}"""
if old not in s: raise SystemExit('split block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('vars and sentence segmentation patched')