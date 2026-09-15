const pages=await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page=pages.find(x=>x.type==='page')||(()=>{throw new Error('no page')})();
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(m.error):p.r(m.result)}};
const cmd=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,{r,j});ws.send(JSON.stringify({id:n,method,params}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ev=async expr=>(await cmd('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true})).result.value;
await cmd('Runtime.enable');await cmd('DOM.enable');await cmd('Page.enable');
await cmd('Page.navigate',{url:'https://readerpro.lakassessoriadigital.workers.dev/'});await sleep(3500);
await ev(`localStorage.clear();`);
const doc=await cmd('DOM.getDocument',{depth:-1,pierce:true});const q=await cmd('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file'});
await cmd('DOM.setFileInputFiles',{nodeId:q.nodeId,files:['C:\\Users\\Adler\\Downloads\\_OceanofPDF.com_marketing_management_-_philip_kotler.pdf']});
for(let i=0;i<60;i++){await sleep(1000);const x=await ev(`({total:document.getElementById('pageTotal')?.textContent,status:document.getElementById('status')?.textContent,title:document.getElementById('docTitle')?.textContent})`);if(i%5===0)console.log('OPEN',i,x);if(x.total?.includes('834'))break;}
await ev(`(()=>{const p=document.getElementById('pageNum');p.value='18';p.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
for(let i=0;i<50;i++){await sleep(1000);const x=await ev(`({status:document.getElementById('status')?.textContent,count:document.querySelectorAll('.sentence').length,buffer:document.getElementById('bufferBadge')?.textContent,title:document.getElementById('docTitle')?.textContent})`);if(i%4===0)console.log('P18',i,x);if(x.count>3&&/pronta/i.test(x.status||'')){console.log('READY',x);break;}}
await cmd('Runtime.evaluate',{expression:`document.getElementById('play').click()`,userGesture:true});await sleep(6500);
console.log('PLAY',await ev(`({play:document.getElementById('play')?.textContent,active:document.querySelector('.sentence.active')?.textContent?.slice(0,180),marks:document.querySelectorAll('.pdfSourceMark').length,buffer:document.getElementById('bufferBadge')?.textContent,status:document.getElementById('status')?.textContent})`));
await cmd('Runtime.evaluate',{expression:`document.getElementById('audiobook').click()`,userGesture:true});await sleep(500);
console.log('AUDIOBOOK',await ev(`({text:document.getElementById('audiobook')?.textContent,on:document.getElementById('audiobook')?.classList.contains('modeOn')})`));ws.close();