from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
s=s.replace(".main{min-height:0;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(360px,.95fr);gap:0}", ".main{min-height:0;display:grid;grid-template-columns:minmax(0,2fr) minmax(340px,1fr);gap:0}")
s=s.replace(".pdfPane{display:block;overflow:auto;padding:26px;background:#080a10;scroll-padding-top:26px}", ".pdfPane{display:block;overflow:auto;padding:18px 22px 30px;background:#080a10;scroll-padding-top:18px}")
s=s.replace(".pdfWrap{position:relative;box-shadow:0 22px 70px #0008;border-radius:5px;overflow:hidden;background:white;min-width:240px;min-height:320px;margin:0 auto 26px}", ".pdfWrap{position:relative;box-shadow:0 22px 70px #0008;border-radius:5px;overflow:hidden;background:white;min-width:240px;min-height:320px;margin:0 auto 30px;width:max-content;max-width:100%}")
old="""  const maxW=Math.max(320,(pdfPane?.clientWidth||720)-54);
  const maxH=Math.max(320,(pdfPane?.clientHeight||720)-54);
  const scale=Math.min(1.65,maxW/viewport0.width,maxH/viewport0.height);"""
new="""  const maxW=Math.max(420,(pdfPane?.clientWidth||900)-44);
  const scale=Math.min(2.2,maxW/viewport0.width);"""
if old not in s: raise SystemExit('scale block not found')
s=s.replace(old,new)
p.write_text(s,encoding='utf-8')
print('2/3 layout + fit-width applied')