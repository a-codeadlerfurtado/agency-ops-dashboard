from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\cdp_voice_timeline.mjs')
s=p.read_text(encoding='utf-8')
old="""const rect=(await cmd('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const r=document.getElementById('play').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`})).result.value;
await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});
"""
new="""await cmd('Runtime.evaluate',{expression:`document.getElementById('play').click()`,userGesture:true});
"""
if old not in s: raise SystemExit('mouse click block not found')
s=s.replace(old,new)
Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\cdp_voice_timeline_usergesture.mjs').write_text(s,encoding='utf-8')
print('userGesture test ready')