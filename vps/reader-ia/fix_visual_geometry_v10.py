from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'app-v2-mobile.mjs'; s=p.read_text(encoding='utf-8-sig')
old="layer.style.width=`${viewport.width}px`;layer.style.height=`${viewport.height}px`;pdfTextGeometry=content.items.map(item=>{const tx=pdfjsLib.Util.transform(viewport.transform,item.transform),h=Math.max(5,Math.hypot(tx[2],tx[3]));return{x:tx[4],y:tx[5]-h,w:Math.max(2,(item.width||0)*viewport.scale),h};});"
new="const visual=fresh.getBoundingClientRect(),sx=visual.width/Math.max(1,viewport.width),sy=visual.height/Math.max(1,viewport.height);layer.style.width=`${visual.width}px`;layer.style.height=`${visual.height}px`;pdfTextGeometry=content.items.map(item=>{const tx=pdfjsLib.Util.transform(viewport.transform,item.transform),rawH=Math.max(5,Math.hypot(tx[2],tx[3]));return{x:tx[4]*sx,y:(tx[5]-rawH)*sy,w:Math.max(2,(item.width||0)*viewport.scale*sx),h:rawH*sy};});"
assert old in s, 'geometry block not found'
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
sw=root/'sw.js'; w=sw.read_text(encoding='utf-8-sig').replace('readerpro-shell-v9','readerpro-shell-v10'); sw.write_text(w,encoding='utf-8')
print('VISUAL_GEOMETRY_V10_OK')