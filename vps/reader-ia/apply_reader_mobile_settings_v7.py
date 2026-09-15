from pathlib import Path
import shutil
base=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
index=base/'index.html'; app=base/'app-v2-mobile.mjs'; sw=base/'sw.js'
for p in (index,app,sw):
    bak=p.with_suffix(p.suffix+'.v7bak')
    if not bak.exists(): shutil.copy2(p,bak)

h=index.read_text(encoding='utf-8-sig')
# Make the PDF marker a true underline instead of a translucent band over glyphs.
h=h.replace(".pdfSourceMark{position:absolute;background:rgba(139,92,246,.24);border-bottom:2px solid rgba(34,211,238,.92);border-radius:3px}",
".pdfSourceMark{position:absolute;background:linear-gradient(90deg,rgba(34,211,238,.72),rgba(59,130,246,.82));border:0;border-radius:999px;box-shadow:0 1px 4px rgba(34,211,238,.28);opacity:.9}")
# Five equal mobile dock actions.
h=h.replace("grid-template-columns:repeat(4,minmax(0,1fr))", "grid-template-columns:repeat(5,minmax(0,1fr))")
settings_css='''
<style id="mobile-settings-v7">
.settingsBackdrop{position:fixed;inset:0;z-index:95;display:none;background:rgba(2,6,12,.54);backdrop-filter:blur(5px)}
.settingsBackdrop.show{display:block}.settingsSheet{position:absolute;left:0;right:0;bottom:0;background:#0e131d;border:1px solid #2a3345;border-bottom:0;border-radius:24px 24px 0 0;padding:10px 16px calc(18px + var(--safe-bottom));box-shadow:0 -20px 60px #000a;transform:translateY(0)}
.settingsGrabber{width:38px;height:4px;border-radius:99px;background:#3b4558;margin:2px auto 13px}.settingsHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.settingsHead strong{font-size:18px}.settingsClose{width:36px;height:36px;padding:0}.settingsField{margin-top:13px}.settingsField label{display:block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#9ea9bc;margin:0 0 7px}.settingsSelect{width:100%;height:48px;max-width:none;border-radius:13px;padding:0 12px;background:#151b27;border:1px solid #303a4d;color:#f6f8fc}.settingsHint{margin-top:13px;font-size:11px;line-height:1.45;color:#7f8a9e}.mobileDock #mobileSettings span{font-size:18px}
@media(min-width:901px){.settingsBackdrop{display:none!important}}
</style>
'''
if 'mobile-settings-v7' not in h:
    h=h.replace('</head>',settings_css+'\n</head>',1)
old='<button id="mobileText" class="active"><span>📝</span>Tradução</button><button id="mobilePlay" class="mobilePlay"><span>▶</span>Ouvir</button>'
new='<button id="mobileText" class="active"><span>📝</span>Tradução</button><button id="mobileSettings"><span>⚙️</span>Ajustes</button><button id="mobilePlay" class="mobilePlay"><span>▶</span>Ouvir</button>'
if old not in h: raise SystemExit('mobile dock marker not found')
h=h.replace(old,new,1)
sheet='''
<div class="settingsBackdrop" id="settingsBackdrop" aria-hidden="true"><div class="settingsSheet" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><div class="settingsGrabber"></div><div class="settingsHead"><strong id="settingsTitle">Ajustes de leitura</strong><button class="btn settingsClose" id="settingsClose" aria-label="Fechar ajustes">✕</button></div><div class="settingsField"><label for="mobileVoice">Voz</label><select class="settingsSelect" id="mobileVoice"></select></div><div class="settingsField"><label for="mobileRate">Velocidade</label><select class="settingsSelect" id="mobileRate"></select></div><div class="settingsHint">As alterações são aplicadas na hora e ficam salvas para a próxima leitura.</div></div></div>
'''
if 'id="settingsBackdrop"' not in h:
    h=h.replace('<div class="libraryOverlay"',sheet+'\n<div class="libraryOverlay"',1)
index.write_text(h,encoding='utf-8')

s=app.read_text(encoding='utf-8-sig')
old="Object.assign(el.style,{left:`${b.x-2}px`,top:`${b.y-1}px`,width:`${b.w+4}px`,height:`${b.h+3}px`});"
new="const thickness=Math.max(2,Math.min(3.2,b.h*.13)),underlineY=b.y+b.h-Math.max(.4,b.h*.025);Object.assign(el.style,{left:`${b.x-1}px`,top:`${underlineY}px`,width:`${b.w+2}px`,height:`${thickness}px`});"
if old not in s: raise SystemExit('highlight geometry marker not found')
s=s.replace(old,new,1)
# Mobile settings helpers and synchronization.
marker="function setMobileView(view){document.body.dataset.mobileView=view;for(const id of ['mobilePdf','mobileText'])$(id)?.classList.toggle('active',(view==='pdf'&&id==='mobilePdf')||(view==='text'&&id==='mobileText'));}"
helpers="""function syncMobileSettingsControls(){const mv=$('mobileVoice'),mr=$('mobileRate'),v=$('voice'),r=$('rate');if(mv&&v){mv.innerHTML=v.innerHTML;mv.value=v.value;}if(mr&&r){mr.innerHTML=r.innerHTML;mr.value=r.value;}}
function showMobileSettings(){syncMobileSettingsControls();const el=$('settingsBackdrop');if(el){el.classList.add('show');el.setAttribute('aria-hidden','false');}}
function hideMobileSettings(){const el=$('settingsBackdrop');if(el){el.classList.remove('show');el.setAttribute('aria-hidden','true');}}
"""
if marker not in s: raise SystemExit('mobile view marker not found')
s=s.replace(marker,helpers+marker,1)
old="$('mobileImport')?.addEventListener('click',()=>$('file')?.click());$('mobileLibrary')?.addEventListener('click',showLibrary);$('mobilePdf')?.addEventListener('click',()=>setMobileView('pdf'));$('mobileText')?.addEventListener('click',()=>setMobileView('text'));$('mobilePlay')?.addEventListener('click',()=>{toggleSpeech();setTimeout(syncMobilePlay,40);});"
new="$('mobileImport')?.addEventListener('click',()=>$('file')?.click());$('mobileLibrary')?.addEventListener('click',showLibrary);$('mobilePdf')?.addEventListener('click',()=>setMobileView('pdf'));$('mobileText')?.addEventListener('click',()=>setMobileView('text'));$('mobileSettings')?.addEventListener('click',showMobileSettings);$('settingsClose')?.addEventListener('click',hideMobileSettings);$('settingsBackdrop')?.addEventListener('click',e=>{if(e.target===$('settingsBackdrop'))hideMobileSettings();});$('mobileVoice')?.addEventListener('change',e=>{const v=$('voice');if(!v)return;v.value=e.target.value;v.dispatchEvent(new Event('change',{bubbles:true}));});$('mobileRate')?.addEventListener('change',e=>{const r=$('rate');if(!r)return;r.value=e.target.value;r.dispatchEvent(new Event('change',{bubbles:true}));});$('mobilePlay')?.addEventListener('click',()=>{unlockMobileAudio();toggleSpeech();setTimeout(syncMobilePlay,40);});"
if old not in s: raise SystemExit('mobile events marker not found')
s=s.replace(old,new,1)
# Keep iOS audio path alive when changing voices while narration is active.
old="if($('voice').value==='system:browser')speakBrowserSegment();else startLocalContinuous();"
new="if($('voice').value==='system:browser')speakBrowserSegment();else if(isiOS){iosPlayGeneration++;try{iosAudio?.pause();}catch{}startIOSContinuous();}else startLocalContinuous();"
if old not in s: raise SystemExit('voice restart marker not found')
s=s.replace(old,new,1)
# Unlock audio from the visible desktop play button too.
s=s.replace("$('play').addEventListener('click',toggleSpeech);", "$('play').addEventListener('click',()=>{unlockMobileAudio();toggleSpeech();});",1)
# Populate the bottom sheet after voices arrive.
s=s.replace("updateAudiobookUi();populateVoices();loadLibrary()", "updateAudiobookUi();populateVoices().then(syncMobileSettingsControls);loadLibrary()",1)
app.write_text(s,encoding='utf-8')
# Force PWA shell refresh.
w=sw.read_text(encoding='utf-8-sig')
w=w.replace("readerpro-shell-v6","readerpro-shell-v7").replace("readerpro-shell-v5","readerpro-shell-v7")
sw.write_text(w,encoding='utf-8')
print('PATCH_V7_OK')
