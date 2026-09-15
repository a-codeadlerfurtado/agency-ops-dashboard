from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8-sig')
old="window.addEventListener('keydown' ,e=>{if(e.code==='Space'&&!/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)){e.preventDefault();toggleSpeech();}if(e.code==='ArrowRight'&&e.altKey){e.preventDefault();loadPage(page+1);}if(e.code==='ArrowLeft'&&e.altKey){e.preventDefault();loadPage(page-1);}});"
new="""window.addEventListener('keydown',e=>{if(e.code==='Space'&&!isTypingTarget(e.target)){e.preventDefault();e.stopPropagation();if(e.repeat)return;if(document.activeElement instanceof HTMLElement&&document.activeElement.tagName==='BUTTON')document.activeElement.blur();toggleSpeech();return;}if(e.code==='Escape'&&document.body.classList.contains('pdf-focus')){e.preventDefault();togglePdfFocus(false);return;}if(e.code==='ArrowRight'&&e.altKey){e.preventDefault();loadPage(page+1);}if(e.code==='ArrowLeft'&&e.altKey){e.preventDefault();loadPage(page-1);}},true);\nwindow.addEventListener('keyup',e=>{if(e.code==='Space'&&!isTypingTarget(e.target)){e.preventDefault();e.stopPropagation();}},true);"""
if old not in s: raise SystemExit('old key handler missing')
s=s.replace(old,new,1)
s=s.replace("updateAudiobookUi();populateVoices();loadLibrary().then(()=>{if(!pdf)showLibrary();});", "updatePdfFocusUi();updateAudiobookUi();populateVoices();loadLibrary().then(()=>{if(!pdf)showLibrary();});")
p.write_text(s,encoding='utf-8')
print('space pause/resume hardened')