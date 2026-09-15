from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\index.html')
s=p.read_text(encoding='utf-8')
old="""  const pdfPage=await pdf.getPage(n);\n  const viewport0=pdfPage.getViewport({scale:1});"""
new="""  const pdfPage=await pdf.getPage(n);\n  const content=pdfTextContentCache.get(n)||await pdfPage.getTextContent();\n  pdfTextContentCache.set(n,content);\n  const viewport0=pdfPage.getViewport({scale:1});"""
if old not in s: raise SystemExit('render content needle missing')
s=s.replace(old,new,1)
old2="""  if(oldCanvas) oldCanvas.replaceWith(fresh); else wrap.appendChild(fresh);\n  $('pdfLoading').classList.remove('show');"""
new2="""  if(oldCanvas) oldCanvas.replaceWith(fresh); else wrap.appendChild(fresh);\n  let layer=wrap.querySelector('#pdfHighlightLayer');\n  if(!layer){layer=document.createElement('div');layer.id='pdfHighlightLayer';layer.className='pdfHighlightLayer';wrap.appendChild(layer);}\n  layer.style.width=viewport.width+'px';layer.style.height=viewport.height+'px';\n  pdfTextGeometry=content.items.map(item=>{\n    const tx=pdfjsLib.Util.transform(viewport.transform,item.transform);\n    const h=Math.max(5,Math.hypot(tx[2],tx[3]));\n    return {x:tx[4],y:tx[5]-h,w:Math.max(2,(item.width||0)*viewport.scale),h};\n  });\n  if(n===page)refreshSourceRanges();\n  $('pdfLoading').classList.remove('show');"""
if old2 not in s: raise SystemExit('render end needle missing')
s=s.replace(old2,new2,1)
p.write_text(s,encoding='utf-8')
print('render geometry/layer patched')