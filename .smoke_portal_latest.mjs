const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page=pages.find(p=>String(p.url||'').includes('312b36f8-agency-ops-dashboard')&&String(p.url||'').includes('/commercial-portal'));
if(!page) throw new Error('preview tab not found');
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(m.error):p.r(m.result)}};
const cmd=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}))});
await cmd('Page.reload',{ignoreCache:true});await new Promise(r=>setTimeout(r,6500));
const x=await cmd('Runtime.evaluate',{expression:`({text:document.body.innerText.slice(0,2600),hasForm:!!document.querySelector('.cp-report-form'),hasError:document.body.innerText.includes('Failed to fetch')})`,returnByValue:true});
console.log(JSON.stringify(x.result.value,null,2));ws.close();
