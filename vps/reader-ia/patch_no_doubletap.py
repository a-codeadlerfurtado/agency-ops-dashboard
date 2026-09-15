from pathlib import Path
base=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
idx=base/'index.html'
s=idx.read_text(encoding='utf-8-sig')
css='''\n/* iOS: comportamento de app — sem zoom por duplo toque; pinch zoom continua permitido */\nhtml,body,.app,.topbar,.main,.pdfPane,.readerPane,.translation,.libraryOverlay,.mobileDock,button,.btn,.fileBtn,input,select{touch-action:manipulation;-webkit-tap-highlight-color:transparent}\nbutton,.btn,.fileBtn,.mobileDock button{-webkit-touch-callout:none;user-select:none;-webkit-user-select:none}\n'''
if 'sem zoom por duplo toque' not in s:
    s=s.replace('</style>',css+'\n</style>',1)
idx.write_text(s,encoding='utf-8')
sw=base/'sw.js'
w=sw.read_text(encoding='utf-8-sig')
w=w.replace("const CACHE='readerpro-shell-v5';","const CACHE='readerpro-shell-v6';").replace("const CACHE='readerpro-shell-v4';","const CACHE='readerpro-shell-v6';").replace("const CACHE='readerpro-shell-v3';","const CACHE='readerpro-shell-v6';")
sw.write_text(w,encoding='utf-8')
print('NO_DOUBLETAP_PATCH_OK')