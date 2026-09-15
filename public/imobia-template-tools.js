(()=>{
const pathOk=()=>/\/app\/accounts\/(\d+)\/settings\/templates/.test(location.pathname);
const accountId=()=>location.pathname.match(/\/app\/accounts\/(\d+)\/settings\/templates/)?.[1];
const csrf=()=>document.querySelector('meta[name="csrf-token"]')?.content||'';
const api=async(url,opt={})=>{const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf(),...(opt.headers||{})},...opt});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||j.message||`HTTP ${r.status}`);return j};
const style='position:fixed;inset:0;background:rgba(15,23,42,.48);z-index:99999;display:grid;place-items:center;padding:20px';
const box='width:min(620px,100%);background:white;color:#0f172a;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.28);padding:22px;font-family:Inter,system-ui,sans-serif';
const field='width:100%;height:40px;border:1px solid #d8dee9;border-radius:9px;padding:0 11px;background:white;color:#0f172a';
const btn='height:38px;border:0;border-radius:9px;padding:0 14px;font-weight:600;cursor:pointer';
async function openModal(){
const aid=accountId();if(!aid)return;
const data=await api(`/api/v1/accounts/${aid}/inboxes`);const all=data.payload||data||[];
const inboxes=all.filter(x=>x.channel_type==='Channel::Whatsapp'&&(x.provider==='whatsapp_cloud'||x.provider_config?.api_key||x.provider_config?.source));
if(!inboxes.length){alert('Nenhum inbox WhatsApp Cloud disponível.');return;}
const overlay=document.createElement('div');overlay.id='imobia-template-modal';overlay.style.cssText=style;
overlay.innerHTML=`<div style="${box}"><div style="display:flex;justify-content:space-between;gap:16px;align-items:start"><div><h2 style="margin:0;font-size:19px">Novo template WhatsApp</h2><p style="margin:5px 0 18px;color:#64748b;font-size:13px">Envie direto para aprovação da Meta.</p></div><button id="it-close" style="${btn};background:#eef2f7">Fechar</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><label style="font-size:13px">Inbox<select id="it-inbox" style="${field};margin-top:5px">${inboxes.map(i=>`<option value="${i.id}">${i.name}</option>`).join('')}</select></label><label style="font-size:13px">Nome<input id="it-name" style="${field};margin-top:5px" placeholder="retorno_lead"></label><label style="font-size:13px">Idioma<input id="it-lang" style="${field};margin-top:5px" value="pt_BR"></label><label style="font-size:13px">Categoria<select id="it-cat" style="${field};margin-top:5px"><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select></label></div><label style="display:block;font-size:13px;margin-top:12px">Texto<textarea id="it-body" rows="6" style="${field};height:auto;min-height:120px;padding:10px;margin-top:5px;resize:vertical" placeholder="Digite o conteúdo do template"></textarea></label><div id="it-status" style="min-height:20px;margin-top:10px;font-size:13px;color:#64748b"></div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="it-submit" style="${btn};background:#2563eb;color:white">Enviar para aprovação</button></div></div>`;
document.body.appendChild(overlay);
overlay.querySelector('#it-close').onclick=()=>overlay.remove();overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
overlay.querySelector('#it-submit').onclick=async()=>{const b=overlay.querySelector('#it-submit'),s=overlay.querySelector('#it-status');const name=overlay.querySelector('#it-name').value.trim(),body=overlay.querySelector('#it-body').value.trim();if(!/^[a-z0-9_]+$/.test(name)){s.textContent='Use apenas minúsculas, números e underscore no nome.';return}if(!body){s.textContent='Informe o texto do template.';return}b.disabled=true;s.textContent='Enviando para a Meta…';try{const inbox=overlay.querySelector('#it-inbox').value;await api(`/api/v1/accounts/${aid}/inboxes/${inbox}/create_message_template`,{method:'POST',body:JSON.stringify({template:{name,language:overlay.querySelector('#it-lang').value.trim()||'pt_BR',category:overlay.querySelector('#it-cat').value,body}})});s.style.color='#15803d';s.textContent='Template enviado para aprovação da Meta.';await api(`/api/v1/accounts/${aid}/inboxes/${inbox}/sync_templates`,{method:'POST'}).catch(()=>{});setTimeout(()=>{overlay.remove();location.reload()},900)}catch(e){s.style.color='#b91c1c';s.textContent=e.message}finally{b.disabled=false}};
}
function mount(){
if(!pathOk()){document.getElementById('imobia-template-create')?.remove();return}
if(document.getElementById('imobia-template-create'))return;
const b=document.createElement('button');b.id='imobia-template-create';b.textContent='Novo template';b.style.cssText='position:fixed;right:28px;bottom:28px;z-index:9990;height:42px;padding:0 17px;border:0;border-radius:11px;background:#2563eb;color:#fff;font:600 14px Inter,system-ui;box-shadow:0 10px 30px rgba(37,99,235,.28);cursor:pointer';
b.onclick=()=>openModal().catch(e=>alert(e.message));document.body.appendChild(b);
}
const push=history.pushState,replace=history.replaceState;history.pushState=function(){push.apply(this,arguments);setTimeout(mount,60)};history.replaceState=function(){replace.apply(this,arguments);setTimeout(mount,60)};addEventListener('popstate',()=>setTimeout(mount,60));
new MutationObserver(()=>mount()).observe(document.documentElement,{childList:true,subtree:true});mount();
})();
