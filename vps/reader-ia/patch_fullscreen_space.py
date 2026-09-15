from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
html=root/'index.html'; s=html.read_text(encoding='utf-8-sig')
s=s.replace('.pdfPane,.readerPane{min-width:0;min-height:0;position:relative}', '.pdfPane,.readerPane{min-width:0;min-height:0;position:relative}body.pdf-focus .main{grid-template-columns:minmax(0,1fr)}body.pdf-focus .readerPane{display:none}body.pdf-focus .pdfPane{padding:12px 24px 30px}body.pdf-focus .pdfWrap{max-width:none}.btn.pdfFocusOn{background:#2a1747;border-color:#8b5cf6;color:#efe7ff;box-shadow:0 0 0 1px #8b5cf633}')
old='<button class="btn" id="next">→</button><div class="spacer"></div>'
new='<button class="btn" id="next">→</button><button class="btn" id="pdfFocus" title="Visualização cheia do PDF" aria-pressed="false">⛶ PDF</button><div class="spacer"></div>'
if old not in s: raise SystemExit('next anchor missing')
s=s.replace(old,new,1)
s=s.replace('.topbar #libraryBtn,.topbar .fileBtn,.topbar .desktopPlay,.topbar .voiceCtl,.topbar .audiobookCtl{display:none!important}', '.topbar #libraryBtn,.topbar .fileBtn,.topbar .desktopPlay,.topbar .voiceCtl,.topbar .audiobookCtl,.topbar #pdfFocus{display:none!important}')
s=s.replace('<script type="module" src="/reader/app-v2.mjs"></script>','<script type="module" src="/reader/app-v2.mjs?v=fullscreen-space-20260910"></script>')
html.write_text(s,encoding='utf-8')
print('index fullscreen ui patched')