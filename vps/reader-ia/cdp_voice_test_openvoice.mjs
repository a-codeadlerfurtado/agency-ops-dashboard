const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page=pages.find(x=>x.type==='page'&&x.url.includes('readerpro'))||pages.find(x=>x.type==='page');
if(!page) throw new Error('page not found');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let seq=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(m.error):resolve(m.result)}};
const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
await cmd('Runtime.enable');await cmd('DOM.enable');await cmd('Page.enable');
await cmd('Page.reload',{ignoreCache:true});await sleep(3500);
const doc=await cmd('DOM.getDocument',{depth:-1,pierce:true});
const q=await cmd('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
if(!q.nodeId) throw new Error('file input missing');
await cmd('DOM.setFileInputFiles',{nodeId:q.nodeId,files:['C:\\Users\\Adler\\agency-ops-hetzner-worktree\\vps\\reader-ia\\voice-test.pdf']});
let ready=false;
for(let i=0;i<45;i++){
  await sleep(1000);
  const r=await cmd('Runtime.evaluate',{returnByValue:true,expression:`({sentences:document.querySelectorAll('.sentence').length,voice:[...document.querySelectorAll('#voice option')].some(o=>o.value==='pm_jarvis')})`});
  const v=r.result.value;if(v?.sentences>0&&v?.voice){ready=true;break;}
}
if(!ready) throw new Error('translation/pm_jarvis never became ready');
await cmd('Runtime.evaluate',{expression:`(()=>{const s=document.getElementById('voice');s.value='pm_jarvis';s.dispatchEvent(new Event('change',{bubbles:true}));})()`});
const rect=await cmd('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const r=document.getElementById('play').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`});
const {x,y}=rect.result.value;
await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
await sleep(9000);
const state=await cmd('Runtime.evaluate',{returnByValue:true,expression:`({play:document.getElementById('play')?.textContent,buffer:document.getElementById('bufferBadge')?.textContent,status:document.getElementById('status')?.textContent,voice:document.getElementById('voice')?.value,active:document.querySelector('.sentence.active')?.textContent||null,sentences:document.querySelectorAll('.sentence').length})`});
console.log(JSON.stringify(state.result.value));
ws.close();
