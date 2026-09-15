from pathlib import Path
src=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2-fixed.mjs')
out=src.with_name('app-v2-mobile.mjs')
s=src.read_text(encoding='utf-8-sig')
# iOS/native audio state
needle="let audioContext=null,currentSource=null,currentBuffer=null,audioTimeline=[],audioScheduleGeneration=0,audioFillRunning=false,highlightRaf=0,lastOffsetPersist=0;"
repl=needle+"\nconst isiOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);\nlet iosAudio=null,iosAudioUrl='',iosPlayGeneration=0;"
assert needle in s
s=s.replace(needle,repl,1)
# unlock helpers before ensureAudioContext
needle="function ensureAudioContext(){if(!audioContext)audioContext=new(window.AudioContext||window.webkitAudioContext)();return audioContext.state==='suspended'?audioContext.resume():Promise.resolve();}"
repl="""function ensureAudioContext(){if(!audioContext)audioContext=new(window.AudioContext||window.webkitAudioContext)();return audioContext.state==='suspended'?audioContext.resume():Promise.resolve();}
function ensureIOSAudio(){if(iosAudio)return iosAudio;iosAudio=new Audio();iosAudio.preload='auto';iosAudio.setAttribute('playsinline','');iosAudio.playsInline=true;iosAudio.volume=1;document.body.appendChild(iosAudio);iosAudio.style.display='none';return iosAudio;}
async function unlockMobileAudio(){try{await ensureAudioContext();if(audioContext){const b=audioContext.createBuffer(1,1,22050),src=audioContext.createBufferSource();src.buffer=b;src.connect(audioContext.destination);src.start(0);}}catch(e){console.warn('audio_context_unlock_failed',e);}if(isiOS){try{const a=ensureIOSAudio();a.src='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQQAAAAAAA==';await a.play();a.pause();a.currentTime=0;}catch(e){console.warn('ios_audio_unlock_failed',e);}}}
"""
assert needle in s
s=s.replace(needle,repl,1)
out.write_text(s,encoding='utf-8')
print('phase1',out.stat().st_size)
s=out.read_text(encoding='utf-8')
# Native iOS playback path
marker="async function startLocalContinuous(){if(!speaking||paused)return;await ensureAudioContext();const generation=audioScheduleGeneration;setBuffer('preparando fluxo contínuo');fillAudioSchedule(generation);scheduleHighlightLoop(generation);}"
ios_fn="""async function playIOSCurrent(generation=iosPlayGeneration){if(!speaking||paused||generation!==iosPlayGeneration)return;if(sentenceIndex>=currentSegments.length){if(page<pdf.numPages)return loadPage(page+1,{autoplay:true});return stopSpeech();}const a=ensureIOSAudio(),text=String(currentSegments[sentenceIndex]?.target||'');setBuffer('preparando áudio no iPhone');try{const blob=await getLocalAudio(text);if(!speaking||paused||generation!==iosPlayGeneration)return;if(iosAudioUrl)URL.revokeObjectURL(iosAudioUrl);iosAudioUrl=URL.createObjectURL(blob);a.src=iosAudioUrl;a.playbackRate=Number($('rate').value)||1;a.currentTime=Math.max(0,currentSentenceOffset||0);a.ontimeupdate=()=>{if(generation!==iosPlayGeneration)return;currentSentenceOffset=a.currentTime||0;updateHighlights();};a.onended=()=>{if(generation!==iosPlayGeneration||!speaking)return;sentenceIndex++;currentSentenceOffset=0;saveProgress();updateHighlights();if(sentenceIndex<currentSegments.length)getLocalAudio(String(currentSegments[sentenceIndex]?.target||'')).catch(()=>{});playIOSCurrent(generation);};await a.play();setBuffer('áudio ativo no iPhone',true);if(sentenceIndex+1<currentSegments.length)getLocalAudio(String(currentSegments[sentenceIndex+1]?.target||'')).catch(()=>{});}catch(e){console.warn('ios_native_audio_failed',e);setStatus(`Áudio no iPhone: ${e.message||e}`);try{await ensureAudioContext();startLocalContinuous();}catch{stopSpeech();}}}
function startIOSContinuous(){iosPlayGeneration++;const generation=iosPlayGeneration;playIOSCurrent(generation);}
"""
assert marker in s
s=s.replace(marker,marker+'\n'+ios_fn,1)
# startSpeech routes local voice to native iOS audio
old="function startSpeech(){if(!currentSegments.length)return;speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateHighlights();if($('voice').value==='system:browser')speakBrowserSegment();else startLocalContinuous();}"
new="function startSpeech(){if(!currentSegments.length)return;speaking=true;paused=false;$('play').textContent='⏸ Pausar';$('play').classList.add('playing');updateHighlights();if($('voice').value==='system:browser')speakBrowserSegment();else if(isiOS)startIOSContinuous();else startLocalContinuous();}"
assert old in s
s=s.replace(old,new,1)
out.write_text(s,encoding='utf-8')
print('phase2')
s=out.read_text(encoding='utf-8')
old="function stopSpeech(){if(speaking)saveProgress();clearScheduledAudio();speechSynthesis.cancel();speaking=false;paused=false;$('play').textContent='▶ Ouvir';$('play').classList.remove('playing');updateHighlights();}"
new="function stopSpeech(){if(speaking)saveProgress();clearScheduledAudio();speechSynthesis.cancel();iosPlayGeneration++;if(iosAudio){try{iosAudio.pause();iosAudio.ontimeupdate=null;iosAudio.onended=null;}catch{}}if(iosAudioUrl){try{URL.revokeObjectURL(iosAudioUrl);}catch{}iosAudioUrl='';}speaking=false;paused=false;$('play').textContent='▶ Ouvir';$('play').classList.remove('playing');updateHighlights();}"
assert old in s
s=s.replace(old,new,1)
old="function toggleSpeech(){if(!speaking){if($('voice').value!=='system:browser')ensureAudioContext();startSpeech();return;}if(!paused){paused=true;saveProgress();if($('voice').value==='system:browser')speechSynthesis.pause();else if(audioContext?.state==='running')audioContext.suspend();$('play').textContent='▶ Continuar';}else{paused=false;$('play').textContent='⏸ Pausar';if($('voice').value==='system:browser')speechSynthesis.resume();else ensureAudioContext().then(()=>{if(!audioTimeline.length)startLocalContinuous();});}}"
new="function toggleSpeech(){if(!speaking){if($('voice').value!=='system:browser')unlockMobileAudio();startSpeech();return;}if(!paused){paused=true;saveProgress();if($('voice').value==='system:browser')speechSynthesis.pause();else if(isiOS){try{iosAudio?.pause();}catch{}}else if(audioContext?.state==='running')audioContext.suspend();$('play').textContent='▶ Continuar';}else{paused=false;$('play').textContent='⏸ Pausar';if($('voice').value==='system:browser')speechSynthesis.resume();else if(isiOS){if(iosAudio?.src)iosAudio.play().catch(()=>playIOSCurrent(iosPlayGeneration));else playIOSCurrent(iosPlayGeneration);}else ensureAudioContext().then(()=>{if(!audioTimeline.length)startLocalContinuous();});}}"
assert old in s
s=s.replace(old,new,1)
out.write_text(s,encoding='utf-8')
print('phase3')
s=out.read_text(encoding='utf-8')
s=s.replace("$('play').addEventListener('click',toggleSpeech);","$('play').addEventListener('click',()=>{unlockMobileAudio();toggleSpeech();});",1)
old="$('rate').addEventListener('change',()=>{saveProgress();if(!speaking)return;if($('voice').value==='system:browser'){const wasPaused=paused;speechSynthesis.cancel();if(wasPaused){speaking=false;paused=false;$('play').textContent='▶ Ouvir';$('play').classList.remove('playing');}else setTimeout(()=>speakBrowserSegment(),30);return;}restartLocalAtCurrent();});"
new="$('rate').addEventListener('change',()=>{saveProgress();if(!speaking)return;if($('voice').value==='system:browser'){const wasPaused=paused;speechSynthesis.cancel();if(wasPaused){speaking=false;paused=false;$('play').textContent='▶ Ouvir';$('play').classList.remove('playing');}else setTimeout(()=>speakBrowserSegment(),30);return;}if(isiOS&&iosAudio){iosAudio.playbackRate=Number($('rate').value)||1;return;}restartLocalAtCurrent();});"
assert old in s
s=s.replace(old,new,1)
old="$('mobilePlay')?.addEventListener('click',()=>{toggleSpeech();setTimeout(syncMobilePlay,40);});"
new="$('mobilePlay')?.addEventListener('click',()=>{unlockMobileAudio();toggleSpeech();setTimeout(syncMobilePlay,40);});"
assert old in s
s=s.replace(old,new,1)
out.write_text(s,encoding='utf-8')
print('phase4')