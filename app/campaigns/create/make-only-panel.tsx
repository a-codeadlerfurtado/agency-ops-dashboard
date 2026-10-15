"use client";
import { useCallback, useEffect, useState } from "react";

type Row = Record<string, any>;
type Props = {
  clientName: string;
  available: boolean;
  api: (payload: Row) => Promise<{ ok: boolean; status: number; body: Row | null }>;
};
const phone = (value: string) => value.replace(/\D/g, "");
const phoneValid = (value: string) => /^55[1-9][0-9]{9,10}$/.test(value);
const friendly: Record<string, string> = {
  make_delivery_not_configured: "A API do Make não está configurada.",
  make_fb_connection_missing: "Falta a conexão Facebook Lead Ads do GT no Make.",
  assets_missing: "Conta de anúncios ou Página não cadastradas para o cliente.",
  make_campaign_form_required: "Selecione uma campanha e um formulário.",
  make_campaign_client_mismatch: "Campanha fora da conta Meta do cliente ou não configurada para leads.",
  make_campaign_form_unavailable: "A Meta não permitiu consultar esta campanha e este formulário.",
  make_campaign_list_unavailable: "Não foi possível consultar as campanhas da conta Meta.",
  make_delivery_form_unavailable: "Formulário não ativo ou não pertencente à Página escolhida.",
  make_delivery_form_already_routed: "Este formulário já possui uma rota Make ou destinatários diferentes. Evite duplicar leads.",
  make_delivery_already_processing: "Há um provisionamento em andamento para este formulário.",
  make_form_already_connected: "Este formulário já possui webhook Make; não foi criado outro.",
  make_form_questions_missing: "A Meta não retornou perguntas suficientes do formulário.",
  make_form_standard_fields_missing: "O formulário precisa ter nome e telefone.",
  make_recipient_invalid: "Número inválido; informe 55 + DDD + celular ou fixo.",
  make_roleta_recipients_invalid: "A roleta precisa de 2 a 25 corretores com nomes e números únicos.",
  make_campaign_filter_unverified: "O Make não confirmou o filtro que restringe os leads à campanha escolhida.",
  make_delivery_audit_failed: "O Make criou um cenário, mas o registro falhou. Não repita antes de conferir o Make.",
  make_delivery_provision_failed: "A automação não foi concluída no Make. Confira o cenário antes de tentar novamente.",
};
const explain = (body: Row | null, fallback: string) =>
  friendly[String(body?.error || "")] ||
  (body?.detail ? fallback + " (" + String(body.detail).slice(0,160) + ")" : fallback);

export default function MakeOnlyPanel({clientName, available, api}: Props) {
  const [campaigns, setCampaigns] = useState<Row[]>([]);
  const [forms, setForms] = useState<Row[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [formId, setFormId] = useState("");
  const [product, setProduct] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"SINGLE"|"ROUND_ROBIN">("SINGLE");
  const [singlePhone, setSinglePhone] = useState("");
  const [recipients, setRecipients] = useState([{name:"", phone:""}, {name:"",phone:""}]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Row | null>(null);
  const [reload, setReload] = useState(0);

  const fetchOptions = useCallback(async (signal: {cancelled:boolean}) => {
    if (!clientName) return;
    setLoading(true);
    setError("");
    try {
      const [c, f] = await Promise.all([
        api({ action: "LIST_MAKE_CAMPAIGNS", client_name: clientName }),
        api({ action: "LIST_LEAD_FORMS", client_name: clientName }),
      ]);
      if (signal.cancelled) return;
      setCampaigns(c.ok && Array.isArray(c.body?.campaigns) ? c.body.campaigns : []);
      setForms(f.ok && Array.isArray(f.body?.forms) ? f.body.forms : []);
      if (!c.ok || !f.ok)
        setError(explain(!c.ok ? c.body : f.body, "Falha ao carregar campanhas ou formulários."));
    } catch {
      if (!signal.cancelled) setError("Falha ao consultar Meta. Atualize a listagem.");
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, [clientName, api]);

  useEffect(() => {
    const signal = {cancelled:false};
    void fetchOptions(signal);
    return () => { signal.cancelled = true; };
  }, [fetchOptions,reload]);

  const submit = async () => {
    if (!available || !clientName || saving || !campaignId || !formId) return;
    setResult(null); setError("");
    if (product.trim().length < 3) { setError("Informe o produto / empreendimento."); return; }
    const single = phone(singlePhone);
    const list = recipients.map(r => ({name:r.name.trim(),phone:phone(r.phone)}));
    if (deliveryMode === "SINGLE" && !phoneValid(single)) {
      setError("Número inválido. Use 55 + DDD + número."); return;
    }
    if (deliveryMode === "ROUND_ROBIN" && (list.length < 2 || list.length > 25 ||
      list.some(r => r.name.length < 2 || !phoneValid(r.phone)) ||
      new Set(list.map(r => r.phone)).size !== list.length)) {
      setError("Informe 2 a 25 corretores com nomes e WhatsApps únicos e válidos."); return;
    }
    setSaving(true);
    try {
      const r = await api({
        action:"CREATE_MAKE_ONLY", confirmation:"CRIAR MAKE",client_name:clientName,
        campaign_id:campaignId,form_id:formId,product:product.trim(),
        delivery_mode:deliveryMode,recipient_phone:single,
        recipients:deliveryMode === "ROUND_ROBIN" ? list : [],
      });
      if (!r.ok) { setError(explain(r.body,"Falha ao criar o cenário Make.")); return; }
      setResult(r.body);
    } catch {
      setError("Conexão interrompida. Verifique se o cenário foi criado antes de tentar novamente.");
    } finally {setSaving(false);}
  };

  return <section className="cb-guide-section" style={{marginTop:16}}>
    <h3>Criar somente Make · campanha existente</h3>
    <p className="cb-hint">Esta operação não cria nem altera campanhas, conjuntos ou anúncios na Meta. O Make só enviará leads do formulário associados ao ID da campanha selecionada, mesmo quando o formulário for compartilhado com outras campanhas.</p>
    {!available && <div className="cb-error">A integração Make ou Facebook Lead Ads ainda não está disponível. Peça à gestão que confira as conexões.</div>}
    <div className="cb-grid">
      <div className="cb-field">
        <label>Campanha existente do cliente *</label>
        <select value={campaignId} disabled={saving || loading} onChange={e=>{setCampaignId(e.target.value);setResult(null);}}>
          <option value="">Selecione a campanha…</option>
          {campaigns.map(c=><option key={c.id} value={c.id}>{c.name} · {c.status}</option>)}
        </select>
      </div>
      <div className="cb-field">
        <label>Formulário ativo da Página *</label>
        <select value={formId} disabled={saving || loading} onChange={e=>{setFormId(e.target.value);setResult(null);}}>
          <option value="">Selecione o formulário…</option>
          {forms.filter(f=>String(f.status).toUpperCase()==="ACTIVE").map(f=><option key={f.id} value={f.id}>{f.name} · #{f.id}</option>)}
        </select>
      </div>
      <div className="cb-field full">
        <label>Nome do produto no WhatsApp *</label>
        <input maxLength={110} disabled={saving} placeholder="Ex.: Apartamentos Jardim Paulista"
          value={product} onChange={e=>{setProduct(e.target.value);setResult(null);}}/>
        <span className="cb-hint">As perguntas e respostas são lidas diretamente do formulário real da Meta.</span>
      </div>
    </div>
    <div className="cb-actions" style={{marginTop:12}}>
      <button type="button" className="cb-btn ghost" disabled={loading || saving} onClick={()=>setReload(v=>v+1)}>
        {loading?"Atualizando…":"Atualizar campanhas e formulários"}
      </button>
    </div>
    <label style={{display:"block",marginTop:16}}>Como distribuir os leads</label>
    <div className="cb-methods" role="group" aria-label="Destinatários do Make">
      <button type="button" className={deliveryMode==="SINGLE"?"chosen":""} disabled={saving} onClick={()=>{setDeliveryMode("SINGLE");setResult(null);}}>WhatsApp único</button>
      <button type="button" className={deliveryMode==="ROUND_ROBIN"?"chosen":""} disabled={saving} onClick={()=>{setDeliveryMode("ROUND_ROBIN");setResult(null);}}>Roleta de corretores</button>
    </div>
    {deliveryMode==="SINGLE" ?
      <div className="cb-field">
        <label>WhatsApp de destino (55 + DDD + número) *</label>
        <input type="tel" inputMode="numeric" maxLength={22} disabled={saving} placeholder="5511999999999"
          value={singlePhone} onChange={e=>{setSinglePhone(e.target.value);setResult(null);}}/>
      </div> :
      <div style={{display:"grid",gap:12}}>
        <p className="cb-hint">Distribuição sequencial: a posição da roleta é salva no Make para evitar repetir o mesmo corretor.</p>
        {recipients.map((r,index)=><div className="cb-grid" key={index}>
          <div className="cb-field"><label>Corretor {index+1} *</label>
            <input maxLength={80} disabled={saving} value={r.name}
              onChange={e=>{setRecipients(old=>old.map((x,i)=>i===index?{...x,name:e.target.value}:x));setResult(null);}}/></div>
          <div className="cb-field"><label>WhatsApp {index+1} *</label>
            <input type="tel" inputMode="numeric" maxLength={22} disabled={saving} placeholder="5511999999999" value={r.phone}
              onChange={e=>{setRecipients(old=>old.map((x,i)=>i===index?{...x,phone:e.target.value}:x));setResult(null);}}/></div>
          {recipients.length>2 && <button type="button" className="cb-btn ghost" disabled={saving}
            onClick={()=>setRecipients(old=>old.filter((_,i)=>i!==index))}>Remover corretor</button>}
        </div>)}
        <button type="button" className="cb-btn ghost" disabled={saving || recipients.length>=25}
          onClick={()=>setRecipients(old=>[...old,{name:"",phone:""}])}>+ Adicionar corretor</button>
      </div>}
    {error && <div className="cb-error" role="alert" style={{marginTop:14}}>{error}</div>}
    {result?.status==="READY" && <div className="cb-success" role="status" style={{marginTop:14}}>
      <b>Cenário Make #{result.scenario_id} {result.reused?"reaproveitado":"criado e ativado"} com sucesso.</b>
      <p>Campanha {campaignId} · formulário {formId} · {deliveryMode==="SINGLE"?"WhatsApp único":"roleta"}.</p>
      <a href={`https://us1.make.com/600315/scenarios/${result.scenario_id}`} target="_blank" rel="noopener noreferrer">Abrir cenário no Make</a>
    </div>}
    <p className="cb-hint" style={{marginTop:16}}>Confirme a campanha, o formulário e os destinatários. Cada formulário aceita uma única rota de entrega ativa para evitar duplicação.</p>
    <button type="button" className="cb-btn primary" onClick={submit}
      disabled={!available || !clientName || !campaignId || !formId || loading || saving}>
      {saving?"Criando e verificando cenário…":"Criar somente automação Make"}
    </button>
  </section>;
}
