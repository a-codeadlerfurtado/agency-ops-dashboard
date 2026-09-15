const FEEDBACK_STYLE = `
#relato-feedback-host{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(2,6,23,.72);backdrop-filter:blur(5px)}
#relato-feedback-host .rf-card{width:min(620px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:#081225;color:#f8fafc;border:1px solid #2b3d60;border-radius:20px;box-shadow:0 28px 90px rgba(0,0,0,.55);font:14px Inter,system-ui,sans-serif;padding:22px}
#relato-feedback-host .rf-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.rf-brand{font-size:12px;color:#8ea2c5}.rf-title{font-size:20px;font-weight:800;margin-top:3px}.rf-sub{color:#91a4c5;font-size:12px;margin-top:5px}.rf-close{border:0;background:transparent;color:#8ea2c5;font-size:22px;cursor:pointer}
.rf-section{margin-top:18px}.rf-label{font-size:11px;color:#91a4c5;font-weight:800;letter-spacing:.04em;margin-bottom:8px}.rf-options{display:flex;gap:7px;flex-wrap:wrap}.rf-chip{border:1px solid #2c4065;background:#0d1a31;color:#d9e4f7;border-radius:999px;padding:8px 11px;cursor:pointer}.rf-chip.active{border-color:#748bff;background:#26376c;color:#fff}.rf-stars{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}.rf-star{border:1px solid #2c4065;background:#0d1a31;color:#9eb0cd;border-radius:10px;padding:9px 4px;cursor:pointer;font-weight:800}.rf-star.active{background:#26376c;border-color:#748bff;color:white}
.rf-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.rf-note{width:100%;min-height:64px;resize:vertical;border:1px solid #2c4065;background:#07101f;color:#fff;border-radius:11px;padding:10px;font:inherit}.rf-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:20px}.rf-btn{border:1px solid #33476c;background:#111e34;color:#e8eefc;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:800}.rf-btn.primary{background:#6177ef;border-color:#6177ef;color:white}.rf-btn:disabled{opacity:.45;cursor:not-allowed}.rf-msg{margin-right:auto;color:#8ea2c5;font-size:11px}@media(max-width:620px){.rf-grid{grid-template-columns:1fr}.rf-stars{grid-template-columns:repeat(5,1fr)}}`;

let activeFeedback = null;
let state = null;
const moods = [["EXCELLENT","😄 Ótimo"],["GOOD","🙂 Bom"],["NEUTRAL","😐 Neutro"],["WORRIED","😟 Preocupado"],["IRRITATED","😠 Irritado"]];
const tones = [["ENTHUSIASTIC","Animado"],["RECEPTIVE","Receptivo"],["NEUTRAL","Neutro"],["COLD","Frio"],["DEFENSIVE","Defensivo"],["IMPATIENT","Impaciente"]];
const directions = [["IMPROVING","↗ Melhorou"],["STABLE","→ Igual"],["WORSENING","↘ Piorou"]];
const tagOptions = ["ABERTURA","CONFIANCA","URGENCIA","DUVIDA","OBJECAO","RESISTENCIA","FRUSTRACAO","RISCO"];
function chips(items, key) {
  return `<div class="rf-options">${items.map(([value,label]) => `<button type="button" class="rf-chip" data-key="${key}" data-value="${value}">${label}</button>`).join("")}</div>`;
}
function stars(key) {
  return `<div class="rf-stars">${[1,2,3,4,5].map((n) => `<button type="button" class="rf-star" data-key="${key}" data-value="${n}">${n}</button>`).join("")}</div>`;
}
function closeFeedback() {
  document.getElementById("relato-feedback-host")?.remove();
  activeFeedback = null;
  state = null;
}
function syncButtons(root) {
  root.querySelectorAll("[data-key]").forEach((button) => {
    const key = button.dataset.key;
    const value = button.dataset.value;
    const current = state?.[key];
    const active = Array.isArray(current) ? current.includes(value) : String(current ?? "") === value;
    button.classList.toggle("active", active);
  });
  const submit = root.querySelector("[data-submit]");
  if (submit) submit.disabled = !(state?.mood && state?.tone);
}
function showFeedback(payload) {
  closeFeedback();
  activeFeedback = payload || {};
  state = { mood:"", tone:"", receptivity:null, trust_level:null, perceived_risk:null, relationship_direction:"STABLE", tags:[], note:"" };
  const host = document.createElement("div"); host.id = "relato-feedback-host";
  host.innerHTML = `<style>${FEEDBACK_STYLE}</style><div class="rf-card"><div class="rf-top"><div><div class="rf-brand">Relato AI · percepção humana</div><div class="rf-title">Como o cliente estava nesta call?</div><div class="rf-sub">${String(activeFeedback.title || "Reunião finalizada")}. Leva menos de 15 segundos.</div></div><button class="rf-close" data-dismiss>×</button></div>
  <div class="rf-section"><div class="rf-label">HUMOR DO CLIENTE</div>${chips(moods,"mood")}</div>
  <div class="rf-section"><div class="rf-label">TOM DE VOZ</div>${chips(tones,"tone")}</div>
  <div class="rf-section rf-grid"><div><div class="rf-label">RECEPTIVIDADE</div>${stars("receptivity")}</div><div><div class="rf-label">CONFIANÇA</div>${stars("trust_level")}</div><div><div class="rf-label">RISCO PERCEBIDO</div>${stars("perceived_risk")}</div></div>
  <div class="rf-section"><div class="rf-label">COMO A RELAÇÃO SAIU DA CALL?</div>${chips(directions,"relationship_direction")}</div>
  <div class="rf-section"><div class="rf-label">SINAIS PERCEBIDOS</div><div class="rf-options">${tagOptions.map((tag)=>`<button type="button" class="rf-chip" data-key="tags" data-value="${tag}">${tag.replaceAll("_"," ")}</button>`).join("")}</div></div>
  <div class="rf-section"><div class="rf-label">NOTA RÁPIDA · OPCIONAL</div><textarea class="rf-note" placeholder="Algo que só quem participou percebeu?"></textarea></div>
  <div class="rf-actions"><span class="rf-msg"></span><button class="rf-btn" data-dismiss>Agora não</button><button class="rf-btn primary" data-submit disabled>Salvar avaliação</button></div></div>`;
  document.documentElement.appendChild(host);
  bindFeedback(host);
}
function bindFeedback(host) {
  host.querySelectorAll("[data-key]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.key; const value = button.dataset.value;
    if (key === "tags") state.tags = state.tags.includes(value) ? state.tags.filter((x) => x !== value) : [...state.tags, value];
    else if (["receptivity","trust_level","perceived_risk"].includes(key)) state[key] = Number(value);
    else state[key] = value;
    syncButtons(host);
  }));
  host.querySelector(".rf-note")?.addEventListener("input", (event) => { state.note = event.target.value.slice(0, 2000); });
  host.querySelectorAll("[data-dismiss]").forEach((button) => button.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type:"HUMAN_FEEDBACK_SAVE", feedback:{ ...activeFeedback, ...state, dismissed:true } }).catch(()=>{});
    closeFeedback();
  }));
  host.querySelector("[data-submit]")?.addEventListener("click", async () => {
    const submit = host.querySelector("[data-submit]"); const msg = host.querySelector(".rf-msg");
    submit.disabled = true; msg.textContent = "Salvando…";
    const result = await chrome.runtime.sendMessage({ type:"HUMAN_FEEDBACK_SAVE", feedback:{ ...activeFeedback, ...state, dismissed:false } }).catch((error)=>({ok:false,error:String(error)}));
    if (result?.ok) { msg.textContent = "Salvo ✓"; setTimeout(closeFeedback, 450); }
    else { msg.textContent = "Não consegui salvar. Tente novamente."; submit.disabled = false; }
  });
  syncButtons(host);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "RELATO_SHOW_FEEDBACK" && message.feedback?.local_session_id) showFeedback(message.feedback);
});
