"use client";

import { useState } from "react";

type Row = Record<string, any>;
type Question = { label: string; optionsText: string };
const defaultQuestions: Question[] = [
  { label: "Qual é sua renda familiar mensal?",
    optionsText: "Até R$ 5.000\nR$ 5.001 a R$ 10.000\nR$ 10.001 a R$ 15.000\nR$ 15.001 a R$ 20.000\nAcima de R$ 20.000" },
  { label: "Qual é seu objetivo com o imóvel?",
    optionsText: "Moradia\nInvestimento\nVeraneio\nAinda estou avaliando" },
];

type Props = {
  requestId: string;
  clientName: string;
  onSelect: (id: string) => void;
  api: (payload: Row) => Promise<{ ok: boolean; body: Row | null; status: number }>;
};

export default function LeadFormComposer({ requestId, clientName, onSelect, api }: Props) {
  const [mode, setMode] = useState<"NEW" | "EXISTING">("NEW");
  const [forms, setForms] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");
  const [name, setName] = useState("Formulário de interesse — " + clientName);
  const [headline, setHeadline] = useState("Receba informações do empreendimento");
  const [policyUrl, setPolicyUrl] = useState("");
  const [followUrl, setFollowUrl] = useState("");
  const [higherIntent, setHigherIntent] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [questions, setQuestions] = useState<Question[]>(defaultQuestions);
  const changeQuestion = (idx: number, key: keyof Question, value: string) =>
    setQuestions((old) => old.map((q, i) => i === idx ? { ...q, [key]: value } : q));

  const describeError = (result: Row | null) => {
    const type = String(result?.error || "");
    const messages: Record<string, string> = {
      draft_expired: "Este rascunho expirou. Gere o plano novamente para criar um formulário.",
      lead_form_page_missing: "A Página do cliente não foi encontrada ou mudou no cadastro da Meta.",
      meta_lead_form_permission: "A integração não tem acesso aos formulários dessa Página. Verifique as permissões de Página e leads.",
      lead_form_create_failed: "A Meta recusou a criação do formulário. Confira as permissões e os links.",
      lead_form_links_required: "Preencha uma política de privacidade HTTPS e o link HTTPS da tela final.",
      lead_form_invalid: "Confira o nome e as perguntas: cada pergunta precisa de duas ou mais respostas distintas.",
      lead_form_audit_failed: "A Meta criou o formulário, mas o registro no Dashboard falhou. Copie o ID informado antes de tentar novamente.",
    };
    return [messages[type] || type || "Não foi possível concluir.", result?.detail ? String(result.detail).slice(0,300) : ""].filter(Boolean).join(" ");
  };
  async function loadForms() {
    setLoading(true); setError("");
    try {
      const { ok, body } = await api({ action: "LIST_LEAD_FORMS", client_name: clientName });
      if (!ok) { setError(describeError(body)); return; }
      setForms(body?.forms || []);
    } catch (e) { setError("Falha na conexão com a Meta. " + String(e).slice(0,120)); }
    finally { setLoading(false); }
  }
  async function createForm() {
    setError("");
    if (!confirmed) { setError("Confirme que autoriza publicar o formulário na Página da Meta."); return; }
    if (name.trim().length < 5) { setError("Informe o nome do formulário."); return; }
    if (![policyUrl, followUrl].every((url) => /^https:\/\//i.test(url.trim()))) {
      setError("Os links de privacidade e da página final devem começar com https://."); return;
    }
    const mapped = questions.map(q => ({
      label: q.label.trim(),
      options: q.optionsText.split(/[\n;]+/).map(x => x.trim()).filter(Boolean),
    }));
    if (!mapped.length || mapped.some(q => q.label.length < 8 || q.options.length < 2 || q.options.length > 8)) {
      setError("Inclua pelo menos uma pergunta com duas a oito respostas."); return;
    }
    setCreating(true);
    try {
      const { ok, body } = await api({
        action: "CREATE_LEAD_FORM", request_id: requestId,
        form: {
          name: name.trim(), headline: headline.trim(),
          privacy_policy_url: policyUrl.trim(),
          follow_up_action_url: followUrl.trim(),
          higher_intent: higherIntent, questions: mapped,
        },
      });
      if (!ok) {
        if (body?.form_id) { setCreatedId(String(body.form_id)); onSelect(String(body.form_id)); }
        setError(describeError(body)); return;
      }
      const id = String(body?.form_id || "");
      if (!/^\d+$/.test(id)) { setError("A Meta não retornou um ID válido."); return; }
      setCreatedId(id); onSelect(id);
    } catch (e) { setError("Falha na conexão ao criar o formulário. " + String(e).slice(0,120)); }
    finally { setCreating(false); }
  }
  const inp: React.CSSProperties = { width: "100%", border: "1px solid #294761", borderRadius: 9,
    background: "#071422", color: "#e8f2fa", padding: "10px 12px", fontSize: 13 };
  const btn: React.CSSProperties = { border: "1px solid #2b4c68", padding: "10px 14px",
    background: "#102338", color: "#e3f2ff", borderRadius: 9, cursor: "pointer", fontWeight: 700 };

  return <div style={{ marginTop: 16, padding: 16, borderRadius: 12, background: "#091827", border: "1px solid #254560" }}>
    <h4 style={{ margin: "0 0 6px", color: "#fff", fontSize: 15 }}>Formulário de leads da Meta</h4>
    <p style={{ margin: "0 0 14px", fontSize: 12, color: "#a4bdce" }}>
      Crie e publique um formulário nesta tela ou escolha um que já exista na Página do cliente.
      O anúncio continua pausado e precisa de confirmação separada.
    </p>
    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
      <button type="button" style={{ ...btn, borderColor: mode === "NEW" ? "#f26b21" : "#2b4c68" }} onClick={() => { setMode("NEW"); setError(""); }}>Criar novo formulário</button>
      <button type="button" style={{ ...btn, borderColor: mode === "EXISTING" ? "#f26b21" : "#2b4c68" }} onClick={() => { setMode("EXISTING"); setError(""); }}>Escolher existente</button>
    </div>
    {mode === "EXISTING" ? <div style={{ display: "grid", gap: 10 }}>
      <button type="button" style={{ ...btn, justifySelf: "start" }} disabled={loading} onClick={loadForms}>
        {loading ? "Buscando formulários…" : "Buscar formulários da Página"}
      </button>
      {forms.length > 0 && <select style={inp} defaultValue="" onChange={e => { if(e.target.value) onSelect(e.target.value); }}>
        <option value="">Selecione pelo nome…</option>
        {forms.filter(f => f.status !== "ARCHIVED" && f.status !== "DELETED").map(f =>
          <option key={f.id} value={f.id}>{f.name || "Sem nome"} ({f.status || "Meta"})</option>)}
      </select>}
      {forms.length === 0 && !loading && <span style={{ fontSize: 12, color: "#92aabc" }}>Clique em buscar para localizar os formulários.</span>}
    </div> : <div style={{ display: "grid", gap: 12 }}>
      <label style={{ fontSize: 12 }}>Nome do formulário<input style={inp} maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label>
      <label style={{ fontSize: 12 }}>Título da etapa de perguntas<input style={inp} maxLength={100} value={headline} onChange={e => setHeadline(e.target.value)}/></label>
      <div style={{ padding: 12, background: "#071522", borderRadius: 9, border: "1px solid #203e54" }}>
        <b style={{ fontSize: 12 }}>Dados de contato incluídos</b>
        <div style={{ fontSize: 12, color: "#adc4d5", marginTop: 5 }}>Nome completo · Telefone / WhatsApp · E-mail</div>
      </div>
      {questions.map((q, index) => <div key={index} style={{ padding: 12, background: "#0b1d2e", border: "1px solid #254660", borderRadius: 10, display: "grid", gap: 9 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <b style={{ fontSize: 12 }}>Pergunta de qualificação {index + 1}</b>
          <button type="button" style={{ ...btn, padding: "3px 10px" }} onClick={() => setQuestions(old => old.filter((_, i) => i !== index))}>Remover</button>
        </div>
        <input style={inp} maxLength={160} value={q.label} onChange={e => changeQuestion(index, "label", e.target.value)} placeholder="Escreva a pergunta"/>
        <label style={{ fontSize: 11, color: "#a4bdce" }}>Respostas (uma por linha)
          <textarea style={{ ...inp, minHeight: 82 }} value={q.optionsText} onChange={e => changeQuestion(index, "optionsText", e.target.value)}/>
        </label>
      </div>)}
      {questions.length < 8 && <button type="button" style={{ ...btn, justifySelf: "start" }}
        onClick={() => setQuestions(old => [...old, { label: "", optionsText: "Opção 1\nOpção 2" }])}>
        + Adicionar pergunta
      </button>}
      <label style={{ fontSize: 12 }}>URL da política de privacidade do cliente (obrigatória)
        <input type="url" style={inp} value={policyUrl} onChange={e => setPolicyUrl(e.target.value)} placeholder="https://seudominio.com.br/politica-de-privacidade"/>
      </label>
      <label style={{ fontSize: 12 }}>Link que aparece após o envio (obrigatório)
        <input type="url" style={inp} value={followUrl} onChange={e => setFollowUrl(e.target.value)} placeholder="https://seudominio.com.br/obrigado"/>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12 }}>
        <input type="checkbox" checked={higherIntent} onChange={e => setHigherIntent(e.target.checked)}/>
        Priorizar maior intenção (otimização para qualidade)
      </label>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12 }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>
        Autorizo publicar este formulário de captura de dados na Página Meta do cliente. Confirmei os links de privacidade e agradecimento.
      </label>
      <button type="button" style={{ ...btn, background: "#d75d20", borderColor: "#e77b3a", justifySelf: "start" }}
        disabled={creating || Boolean(createdId)} onClick={createForm}>
        {creating ? "Publicando formulário…" : createdId ? "Formulário publicado" : "Criar formulário na Meta"}
      </button>
      <span style={{ fontSize: 11, color: "#90b2c7" }}>Criar formulário não cria nem ativa campanhas ou anúncios.</span>
    </div>}
    {createdId && <p style={{ color: "#8ee1aa", fontSize: 12, fontWeight: 700 }}>Formulário publicado na Meta e vinculado ao plano · ID {createdId}</p>}
    {error && <div role="alert" style={{ background: "rgba(160,37,45,.18)", border: "1px solid #8c303a", borderRadius: 9, padding: 10, color: "#ffa2a6", marginTop: 11, fontSize: 12 }}>{error}</div>}
  </div>;
}
