from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2.mjs')
s=p.read_text(encoding='utf-8-sig')
s=s.replace("await openPdfBytes(bytes,{name:f.name,size:f.size,lastModified:f.lastModified});});});", "await openPdfBytes(bytes,{name:f.name,size:f.size,lastModified:f.lastModified});});")
anchor="function restartLocalAtCurrent(){const wasPaused=paused;clearScheduledAudio();if(!wasPaused){paused=false;startLocalContinuous();}}\n"
insert="""function updatePdfFocusUi(){const on=document.body.classList.contains('pdf-focus'),b=$('pdfFocus');if(!b)return;b.classList.toggle('pdfFocusOn',on);b.setAttribute('aria-pressed',on?'true':'false');b.textContent=on?'↙ Voltar':'⛶ PDF';b.title=on?'Voltar para PDF + tradução':'Visualização cheia do PDF';}\nasync function togglePdfFocus(force){const next=typeof force==='boolean'?force:!document.body.classList.contains('pdf-focus');document.body.classList.toggle('pdf-focus',next);updatePdfFocusUi();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));if(pdf){try{await renderPdfPage(page);updateHighlights();}catch(e){console.warn('pdf_focus_render_failed',e);}}}\nfunction isTypingTarget(el){return !!(el&&(el.isContentEditable||/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)));}\n"""
if anchor not in s: raise SystemExit('restart anchor missing')
s=s.replace(anchor,anchor+insert,1)
old="$('play').addEventListener('click',toggleSpeech);$('audiobook').addEventListener('click',toggleAudiobook);$('prev').addEventListener('click',()=>loadPage(page-1));$('next').addEventListener('click',()=>loadPage(page+1));$('pageNum').addEventListener('change',()=>loadPage(Number($('pageNum').value)||1));"
new=old+"$('pdfFocus')?.addEventListener('click',()=>togglePdfFocus());"
if old not in s: raise SystemExit('controls anchor missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('app fullscreen core + syntax fix patched')