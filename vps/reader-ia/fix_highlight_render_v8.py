from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\app-v2-mobile.mjs')
s=p.read_text(encoding='utf-8-sig')
old="for(const b of lines){const el=document.createElement('div');el.className='pdfSourceMark';const thickness=Math.max(2,Math.min(3.2,b.h*.13)),underlineY=b.y+b.h-Math.max(.4,b.h*.025);Object.assign(el.style,{left:`${b.x-1}px`,top:`${underlineY}px`,width:`${b.w+2}px`,height:`${thickness}px`});layer.appendChild(el);}"
new="for(const b of lines){const el=document.createElement('div');el.className='pdfSourceMark';const px=Math.max(1,Math.min(3,b.h*.12)),py=Math.max(1,Math.min(2,b.h*.08));Object.assign(el.style,{left:`${b.x-px}px`,top:`${b.y-py}px`,width:`${b.w+px*2}px`,height:`${b.h+py*2}px`});layer.appendChild(el);}"
assert old in s
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('PURPLE_RENDER_OK')