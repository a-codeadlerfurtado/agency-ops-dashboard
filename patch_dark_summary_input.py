from pathlib import Path
p=Path('index.js')
s=p.read_text(encoding='utf-8')
old='.summary-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}'
new='''.summary-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.summary-page .field{display:grid;gap:8px;color:var(--muted)!important;font-size:11px!important;font-weight:600!important}.summary-page input,.summary-page textarea,.summary-page select{width:100%!important;background:#0d1721!important;border:1px solid #2b3b4b!important;color:var(--text)!important;-webkit-text-fill-color:var(--text)!important;border-radius:11px!important;padding:13px 14px!important;min-height:48px!important;outline:none!important;box-shadow:inset 0 1px 0 #ffffff05!important;color-scheme:dark!important;transition:border-color .18s,box-shadow .18s,background .18s}.summary-page input::placeholder,.summary-page textarea::placeholder{color:#7f93a3!important;-webkit-text-fill-color:#7f93a3!important;opacity:1!important}.summary-page input:hover,.summary-page textarea:hover,.summary-page select:hover{border-color:#40566b!important}.summary-page input:focus,.summary-page textarea:focus,.summary-page select:focus{background:#101d29!important;border-color:var(--blue)!important;box-shadow:0 0 0 3px #168ae626!important}.summary-page input:-webkit-autofill,.summary-page input:-webkit-autofill:hover,.summary-page input:-webkit-autofill:focus{-webkit-box-shadow:0 0 0 1000px #0d1721 inset!important;-webkit-text-fill-color:var(--text)!important;caret-color:var(--text)!important}'''
if old not in s:
    raise SystemExit('target not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('patched', p, 'bytes', p.stat().st_size)
