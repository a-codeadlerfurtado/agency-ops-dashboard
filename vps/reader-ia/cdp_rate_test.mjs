const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page=pages.find(x=>x.type==='page')||null;if(!page)throw new Error('no page');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pend=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.j(m.error):p.r(m.result)}};
const cmd=(method,params={})=>new Promise((r,j)=>{const n=++id;pend.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));await cmd('Runtime.enable');
await cmd('Page.navigate',{url:'https://readerpro.lakassessoriadigital.workers.dev/'});await sleep(2500);
const doc=await cmd('DOM.getDocument',{depth:-1,pierce:true});const q=await cmd('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
await cmd('DOM.setFileInputFiles',{nodeId:q.nodeId,files:['C:\\Users\\Adler\\agency-ops-hetzner-worktree\\vps\\reader-ia\\buffer-test.pdf']});
for(let i=0;i<40;i++){await sleep(500);const x=await cmd('Runtime.evaluate',{returnByValue:true,expression:`document.querySelectorAll('.sentence').length`});if(x.result.value>0)break;}
await cmd('Runtime.evaluate',{userGesture:true,expression:`(()=>{const v=document.getElementById('voice');v.value='pm_alex';v.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('play').click();})()`});
for(let i=0;i<30;i++){await sleep(300);const x=await cmd('Runtime.evaluate',{returnByValue:true,expression:`document.getElementById('bufferBadge').textContent`});if(String(x.result.value).includes('lendo'))break;}
const snap=async label=>{const x=await cmd('Runtime.evaluate',{returnByValue:true,expression:`({play:document.getElementById('play').textContent,buffer:document.getElementById('bufferBadge').textContent,rate:document.getElementById('rate').value,active:document.querySelector('.sentence.active')?.textContent||null})`});console.log(label,JSON.stringify(x.result.value));};
await snap('BEFORE');await cmd('Runtime.evaluate',{expression:`(()=>{const r=document.getElementById('rate');r.value='1.5';r.dispatchEvent(new Event('change',{bubbles:true}));})()`});await sleep(250);await snap('AFTER_1_5');
await cmd('Runtime.evaluate',{expression:`(()=>{const r=document.getElementById('rate');r.value='2';r.dispatchEvent(new Event('change',{bubbles:true}));})()`});await sleep(250);await snap('AFTER_2');ws.close();