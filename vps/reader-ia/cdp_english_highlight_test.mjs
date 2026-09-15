const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const pg=pages.find(x=>x.type==='page'&&x.url.includes('readerpro'))||pages.find(x=>x.type==='page');
if(!pg) throw new Error('page not found');
const ws=new WebSocket(pg.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(m.error):p.r(m.result)}};
const cmd=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}))});
await cmd('Runtime.enable');await cmd('DOM.enable');await cmd('Page.reload',{ignoreCache:true});await sleep(2500);
const doc=await cmd('DOM.getDocument',{depth:-1,pierce:true});const q=await cmd('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
await cmd('DOM.setFileInputFiles',{nodeId:q.nodeId,files:['C:\\Users\\Adler\\agency-ops-hetzner-worktree\\vps\\reader-ia\\voice-test.pdf']});
for(let i=0;i<40;i++){await sleep(500);const r=await cmd('Runtime.evaluate',{returnByValue:true,expression:`document.querySelectorAll('.sentence').length`});if(r.result.value>0)break;}
await cmd('Runtime.evaluate',{expression:`(()=>{const s=document.getElementById('voice'); if([...s.options].some(o=>o.value==='pm_jarvis')) s.value='pm_jarvis'; document.getElementById('play').click();})()`,userGesture:true});
await sleep(4500);
const r=await cmd('Runtime.evaluate',{returnByValue:true,expression:`({marks:[...document.querySelectorAll('.pdfSourceMark')].map(x=>({l:x.style.left,t:x.style.top,w:x.style.width,h:x.style.height})),active:document.querySelector('.sentence.active')?.textContent||null,buffer:document.getElementById('bufferBadge')?.textContent,pdfScroll:document.querySelector('.pdfPane')?.scrollTop})`});
console.log(JSON.stringify(r.result.value,null,2));ws.close();