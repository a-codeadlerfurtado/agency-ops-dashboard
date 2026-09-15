from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
s=s.replace("""  const active=document.querySelector('.sentence.active');
  if(active) active.scrollIntoView({behavior:'smooth',block:'center'});""", """  const active=document.querySelector('.sentence.active');
  if(active){
    const pane=$('translation'),r=active.getBoundingClientRect(),pr=pane.getBoundingClientRect();
    if(r.top<pr.top+36||r.bottom>pr.bottom-72) active.scrollIntoView({behavior:'auto',block:'center'});
  }""")
old="""  // Kokoro audio is cached once at 1x; change playback speed instantly in-browser.
  if(currentSource){currentSource.playbackRate.setValueAtTime(rate,audioContext.currentTime);}
  setBuffer(`voz local • ${rate}x`,true);"""
new="""  // Rebuild the already-decoded local schedule so sentence boundaries stay sample-accurate.
  const wasPaused=paused;
  clearScheduledAudio();
  setBuffer(`voz local • ${rate}x`,true);
  if(!wasPaused){paused=false;startLocalContinuous();}"""
if old not in s: raise SystemExit('rate block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('scroll timing and rate schedule patched')