const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page=pages.find(x=>x.type==='page')||pages[0]; if(!page) throw new Error('no page');
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let seq=0;const pend=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));await cmd('Page.enable');await cmd('Runtime.enable');await cmd('DOM.enable');
await cmd('Page.navigate',{url:'https://readerpro.lakassessoriadigital.workers.dev/'});await sleep(3500);
const doc=await cmd('DOM.getDocument',{depth:-1,pierce:true});const q=await cmd('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
await cmd('DOM.setFileInputFiles',{nodeId:q.nodeId,files:['C:\\Users\\Adler\\agency-ops-hetzner-worktree\\vps\\reader-ia\\buffer-test.pdf']});
for(const sec of [2,8,16,28]){await sleep(sec===2?2000:(sec-(sec===8?2:sec===16?8:16))*1000);const r=await cmd('Runtime.evaluate',{returnByValue:true,expression:`({status:document.getElementById('status')?.textContent,buffer:document.getElementById('bufferBadge')?.textContent,page:document.getElementById('pageNum')?.value,sentences:document.querySelectorAll('.sentence').length})`});console.log('T+'+sec+'s',JSON.stringify(r.result.value));}
ws.close();