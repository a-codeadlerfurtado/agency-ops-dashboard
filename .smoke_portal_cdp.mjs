const url='ws://127.0.0.1:9333/devtools/page/321F388090F0F3A02620A0852F97B4F6';
const ws=new WebSocket(url); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0; const pending=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(m.error):p.r(m.result)}};
const cmd=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}))});
await cmd('Runtime.enable'); await new Promise(r=>setTimeout(r,6500));
const x=await cmd('Runtime.evaluate',{expression:`({title:document.title,url:location.href,text:document.body.innerText.slice(0,2400),buttons:[...document.querySelectorAll('button')].map(x=>x.innerText).slice(0,20)})`,returnByValue:true});
console.log(JSON.stringify(x.result.value,null,2)); ws.close();
