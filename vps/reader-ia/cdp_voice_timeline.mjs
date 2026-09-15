const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page=pages.find(x=>x.type==='page'&&x.url.includes('readerpro'))||pages.find(x=>x.type==='page');
if(!page) throw new Error('page not found');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const p=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.j(m.error):x.r(m.result)}};
const cmd=(method,params={})=>new Promise((r,j)=>{const n=++id;p.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}))});
await cmd('Runtime.enable');await cmd('DOM.enable');await cmd('Page.enable');
await cmd('Page.reload',{ignoreCache:true});await sleep(3500);
await cmd('Runtime.evaluate',{expression:`localStorage.clear()`});
const doc=await cmd('DOM.getDocument',{depth:-1,pierce:true});const q=await cmd('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
await cmd('DOM.setFileInputFiles',{nodeId:q.nodeId,files:['C:\\Users\\Adler\\agency-ops-hetzner-worktree\\vps\\reader-ia\\voice-test.pdf']});
for(let i=0;i<45;i++){await sleep(1000);const r=await cmd('Runtime.evaluate',{returnByValue:true,expression:`document.querySelectorAll('.sentence').length`});if(r.result.value>0)break;}
await cmd('Runtime.evaluate',{expression:`(()=>{const s=document.getElementById('voice');s.value='pm_alex';s.dispatchEvent(new Event('change',{bubbles:true}));})()`});
const rect=(await cmd('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const r=document.getElementById('play').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`})).result.value;
await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});
const snap=async label=>{const r=await cmd('Runtime.evaluate',{returnByValue:true,expression:`({play:document.getElementById('play')?.textContent,buffer:document.getElementById('bufferBadge')?.textContent,active:document.querySelector('.sentence.active')?.textContent||null,done:document.querySelectorAll('.sentence.done').length,status:document.getElementById('status')?.textContent})`});console.log(label,JSON.stringify(r.result.value));};
await sleep(1000);await snap('T+1s');await sleep(3000);await snap('T+4s');await sleep(4000);await snap('T+8s');ws.close();