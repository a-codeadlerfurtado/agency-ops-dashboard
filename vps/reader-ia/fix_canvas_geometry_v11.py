from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'app-v2-mobile.mjs'; s=p.read_text(encoding='utf-8-sig')
old="const visual=fresh.getBoundingClientRect(),sx=visual.width/Math.max(1,viewport.width),sy=visual.height/Math.max(1,viewport.height);layer.style.width=`${visual.width}px`;layer.style.height=`${visual.height}px`;pdfTextGeometry=content.items.map(item=>{const tx=pdfjsLib.Util.transform(viewport.transform,item.transform),rawH=Math.max(5,Math.hypot(tx[2],tx[3]));return{x:tx[4]*sx,y:(tx[5]-rawH)*sy,w:Math.max(2,(item.width||0)*viewport.scale*sx),h:rawH*sy};});"
new="layer.style.width=`${viewport.width}px`;layer.style.height=`${viewport.height}px`;pdfTextGeometry=content.items.map(item=>{const tx=pdfjsLib.Util.transform(viewport.transform,item.transform),h=Math.max(5,Math.hypot(tx[2],tx[3]));return{x:tx[4],y:tx[5]-h,w:Math.max(2,(item.width||0)*viewport.scale),h};});"
assert old in s
s=s.replace(old,new,1); p.write_text(s,encoding='utf-8')
idx=root/'index.html'; h=idx.read_text(encoding='utf-8-sig')
h=h.replace('.pdfWrap canvas{display:block;max-width:100%!important;width:100%!important;height:auto!important}', '.pdfWrap canvas{display:block;max-width:100%!important;width:auto!important;height:auto!important}',1)
idx.write_text(h,encoding='utf-8')
sw=root/'sw.js'; w=sw.read_text(encoding='utf-8-sig').replace('readerpro-shell-v10','readerpro-shell-v11'); sw.write_text(w,encoding='utf-8')
print('CANVAS_GEOMETRY_V11_OK')