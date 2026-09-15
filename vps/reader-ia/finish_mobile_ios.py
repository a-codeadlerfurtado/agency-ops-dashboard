from pathlib import Path
base=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
app=base/'app-v2-mobile.mjs'
s=app.read_text(encoding='utf-8')
# Fit PDF to real phone width
s=s.replace("maxW=Math.max(420,(pane?.clientWidth||900)-44)","maxW=Math.max(280,(pane?.clientWidth||900)-16)",1)
# Keep Safari media session alive while TTS is prepared
old="async function unlockMobileAudio(){try{await ensureAudioContext();if(audioContext){const b=audioContext.createBuffer(1,1,22050),src=audioContext.createBufferSource();src.buffer=b;src.connect(audioContext.destination);src.start(0);}}catch(e){console.warn('audio_context_unlock_failed',e);}if(isiOS){try{const a=ensureIOSAudio();a.src='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQQAAAAAAA==';await a.play();a.pause();a.currentTime=0;}catch(e){console.warn('ios_audio_unlock_failed',e);}}}"
new="async function unlockMobileAudio(){let iosPlay=null;if(isiOS){try{const a=ensureIOSAudio();a.loop=true;a.src=BASE+'/assets/silence.mp3';iosPlay=a.play();}catch(e){console.warn('ios_audio_unlock_failed',e);}}try{await ensureAudioContext();if(audioContext){const b=audioContext.createBuffer(1,1,22050),src=audioContext.createBufferSource();src.buffer=b;src.connect(audioContext.destination);src.start(0);}}catch(e){console.warn('audio_context_unlock_failed',e);}if(iosPlay)try{await iosPlay;}catch(e){console.warn('ios_audio_play_blocked',e);}}"
assert old in s
s=s.replace(old,new,1)
# Switch from silent loop to real voice
s=s.replace("if(iosAudioUrl)URL.revokeObjectURL(iosAudioUrl);iosAudioUrl=URL.createObjectURL(blob);a.src=iosAudioUrl;","if(iosAudioUrl)URL.revokeObjectURL(iosAudioUrl);iosAudioUrl=URL.createObjectURL(blob);a.loop=false;a.src=iosAudioUrl;",1)
app.write_text(s,encoding='utf-8')
print('app ios fit patched')
s=app.read_text(encoding='utf-8')
# Avoid double unlock calls; toggleSpeech already unlocks on first play
s=s.replace("$('play').addEventListener('click',()=>{unlockMobileAudio();toggleSpeech();});","$('play').addEventListener('click',toggleSpeech);",1)
s=s.replace("$('mobilePlay')?.addEventListener('click',()=>{unlockMobileAudio();toggleSpeech();setTimeout(syncMobilePlay,40);});","$('mobilePlay')?.addEventListener('click',()=>{toggleSpeech();setTimeout(syncMobilePlay,40);});",1)
# Mobile import shortcut inside library
needle="$('mobileLibrary')?.addEventListener('click',showLibrary);"
s=s.replace(needle,"$('mobileImport')?.addEventListener('click',()=>$('file')?.click());"+needle,1)
app.write_text(s,encoding='utf-8')
print('app events patched')

index=base/'index.html'
h=index.read_text(encoding='utf-8')
h=h.replace('<div class="libraryHeadActions"><button class="btn" id="installApp">＋ App</button>', '<div class="libraryHeadActions"><button class="btn mobileImport" id="mobileImport">＋ PDF</button><button class="btn" id="installApp">＋ App</button>',1)
# Add final mobile-first overrides
css='''\n<style id="mobile-v4">\n.mobileImport{display:none}\n@media(max-width:900px){html,body,.app{width:100%;max-width:100%;overflow:hidden}.topbar{width:100%;max-width:100%;overflow:hidden;flex-wrap:nowrap}.topbar #libraryBtn,.topbar .fileBtn,.topbar .desktopPlay,.topbar .voiceCtl,.topbar .audiobookCtl{display:none!important}.topbar .brandName,.topbar .pageTotalLabel{display:none!important}.topbar .spacer{display:block!important;flex:1 1 auto;min-width:4px}.rateCtl{margin-left:0!important;width:62px!important;max-width:62px;flex:0 0 62px}.main,.pdfPane,.readerPane{width:100%;max-width:100%;overflow-x:hidden}.pdfPane{padding:8px 6px calc(64px + var(--safe-bottom))}.pdfWrap{width:100%;max-width:100%;min-width:0;margin:0 auto 16px;box-shadow:none}.pdfWrap canvas{display:block;max-width:100%!important;width:100%!important;height:auto!important}.readerHeader{padding:11px 14px 9px}.readerHeader .eyebrow{font-size:9px}.title{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{font-size:10px;max-height:29px}.translation{width:100%;max-width:100%;padding:16px 15px calc(118px + var(--safe-bottom));font-size:18px;line-height:1.62;overflow-x:hidden;overflow-wrap:anywhere}.bottom{left:9px;right:9px;bottom:calc(60px + var(--safe-bottom));padding:8px 9px}.small{min-width:0}.small>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{max-width:44%;overflow:hidden;text-overflow:ellipsis}.mobileDock{width:100%;max-width:100%;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;padding:5px 6px calc(5px + var(--safe-bottom))}.mobileDock button{min-width:0;height:46px;font-size:10px;padding:0 2px}.libraryOverlay{width:100%;max-width:100%;height:100dvh;padding:calc(14px + var(--safe-top)) 10px calc(14px + var(--safe-bottom));overflow-x:hidden}.libraryShell,.libraryGrid{width:100%;max-width:100%}.libraryHead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin-bottom:12px}.libraryHead h1{font-size:23px;line-height:1.05}.libraryHead p{display:none}.libraryHeadActions{margin:0;gap:5px}.libraryHeadActions .btn{height:34px;padding:0 8px;font-size:12px}.mobileImport{display:inline-flex}.libraryGrid{display:block}.bookCard{width:100%;max-width:100%;grid-template-columns:88px minmax(0,1fr);gap:11px;padding:11px;margin-bottom:10px;border-radius:16px}.bookCard>div:last-child{min-width:0}.bookCoverFrame{width:88px;border-radius:9px}.bookTitle{font-size:15px;line-height:1.15;overflow-wrap:anywhere}.bookAuthors{font-size:10px;line-height:1.3}.bookDesc{font-size:11px;line-height:1.35;margin:7px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.bookMeta{font-size:9px;gap:2px}.bookActions{margin-top:8px}.bookActions .btn{height:34px;font-size:12px}.installHelp{margin:0 0 10px;padding:10px;font-size:11px}}\n@media(max-width:360px){.logo{width:30px;height:30px}.topbar{gap:4px;padding-left:6px;padding-right:6px}.pageInput{width:43px}.rateCtl{width:58px!important;max-width:58px;flex-basis:58px}.bookCard{grid-template-columns:78px minmax(0,1fr)}.bookCoverFrame{width:78px}.libraryHead h1{font-size:21px}}\n</style>\n'''
h=h.replace('</head>',css+'</head>',1)
index.write_text(h,encoding='utf-8')
print('index mobile override patched')