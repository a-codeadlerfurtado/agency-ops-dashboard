from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("  const speed=Number($('rate').value)||1;\n  const key=`${voice}|${speed}|${text}`;", "  const speed=1; // cache canonical audio once; playback speed is client-side\n  const key=`${voice}|${text}`;")
s=s.replace("    currentSource.buffer=currentBuffer;\n    currentSource.connect(audioContext.destination);", "    currentSource.buffer=currentBuffer;\n    currentSource.playbackRate.value=Number($('rate').value)||1;\n    currentSource.connect(audioContext.destination);")
old="""$('rate').addEventListener('change',()=>{\n  saveProgress();\n  if(speaking){\n    const wasPaused=paused;audioRequestToken++;cleanupAudio();speechSynthesis.cancel();\n    if(!wasPaused){paused=false;setTimeout(()=>speakCurrentSentence(),60);}\n  }\n});"""
new="""$('rate').addEventListener('change',()=>{\n  saveProgress();\n  const rate=Number($('rate').value)||1;\n  if(!speaking) return;\n  if($('voice').value==='system:browser'){\n    // SpeechSynthesis cannot change an utterance rate in-place; restart only this sentence.\n    const wasPaused=paused;speechSynthesis.cancel();\n    if(!wasPaused){paused=false;setTimeout(()=>speakBrowserSentence(),40);}\n    return;\n  }\n  // Kokoro audio is cached once at 1x; change playback speed instantly in-browser.\n  if(currentSource){currentSource.playbackRate.setValueAtTime(rate,audioContext.currentTime);}\n  setBuffer(`voz local • ${rate}x`,true);\n});"""
if old not in s: raise SystemExit('rate handler not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('rate switching no longer regenerates Kokoro audio')