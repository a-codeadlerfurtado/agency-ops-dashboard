from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="""function prebufferUpcoming(count=3){\n  if($('voice').value==='system:browser') return;\n  for(let i=1;i<=count;i++){\n    const idx=sentenceIndex+i;\n    if(idx<currentSentences.length) getLocalAudio(currentSentences[idx]).catch(()=>{});\n  }\n}"""
new="""let prebufferGeneration=0;\nasync function prebufferUpcoming(count=2){\n  if($('voice').value==='system:browser') return;\n  const generation=++prebufferGeneration;\n  for(let i=1;i<=count;i++){\n    if(generation!==prebufferGeneration||!speaking) return;\n    const idx=sentenceIndex+i;\n    if(idx>=currentSentences.length) return;\n    try{await getLocalAudio(currentSentences[idx]);}catch{return;}\n  }\n}"""
assert old in s
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('sequential low-pressure prebuffer enabled')