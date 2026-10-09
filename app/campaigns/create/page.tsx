"use client";

// Criar Campanha — o GT descreve a campanha em texto livre, a IA monta o plano
// (campanha + conjunto + anúncio), o GT revisa o preview, ajusta e confirma.
// Tudo é criado PAUSADO na conta do cliente via agency-ops-campaign-builder-api.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import LeadFormComposer from "./lead-form-composer";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-campaign-builder-api`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;


type Guided = {
 objective:"OUTCOME_LEADS"|"OUTCOME_TRAFFIC"; destination:"LEAD_FORM"|"WHATSAPP"|"SITE";
 product:string; budget:string; cities:string; radius:string; intent:string;
 campaignName:string; formId:string; siteUrl:string; start:string; end:string;
 text:string; headline:string; notes:string;
};
const guidedDefault:Guided = {
 objective:"OUTCOME_LEADS",destination:"LEAD_FORM",product:"",budget:"10",cities:"",radius:"",
 intent:"TODOS",campaignName:"",formId:"",siteUrl:"",start:"",end:"",text:"",headline:"",notes:""
};
const guidedValidate=(g:Guided):string=>{
 if(g.product.trim().length<3)return "Informe o nome do imóvel ou empreendimento.";
 if(!Number.isFinite(Number(g.budget))||Number(g.budget)<1||Number(g.budget)>100000)return "Informe um orçamento diário válido entre R$ 1 e R$ 100.000.";
 if(g.cities.trim().length<3)return "Informe a cidade ou região desejada.";
 if(g.radius&&(!Number.isFinite(Number(g.radius))||Number(g.radius)<1||Number(g.radius)>80))return "O raio deve ser de 1 a 80 km.";
 if(g.objective==="OUTCOME_TRAFFIC"&&g.destination!=="SITE")return "Tráfego precisa ter o site como destino.";
 if(g.objective==="OUTCOME_LEADS"&&!["LEAD_FORM","WHATSAPP"].includes(g.destination))return "Selecione formulário ou WhatsApp como destino.";
 if(g.destination==="SITE"&&!/^https:\/\//.test(g.siteUrl.trim()))return "Informe um link HTTPS para a página.";
 if(g.formId&&!/^\d{5,30}$/.test(g.formId))return "O ID do formulário deve conter apenas números.";
 if(g.start&&g.end&&g.start>g.end)return "A data de término deve ser posterior à data de início.";
 return "";
};
const guidedToPrompt=(g:Guided):string=>([
 "Configure uma campanha Meta Ads para o empreendimento "+g.product.trim()+".",
 "Objetivo "+g.objective+". Destino: "+g.destination+".",
 "Orçamento único para o conjunto: R$ "+Number(g.budget).toFixed(2)+" por dia; NÃO multiplicar pela quantidade de anúncios.",
 "Região: "+g.cities.trim()+"; idade abrangente e segmentação compatível com políticas Meta de moradia.",
 g.radius?"Raio geográfico: "+g.radius+" km.":"",
 "Interesse comercial do lead: "+(g.intent==="INVESTIMENTO"?"investimento":g.intent==="MORADIA"?"moradia":"moradia ou investimento")+".",
 g.formId?"Usar formulário Meta existente ID "+g.formId+".":"",
 g.siteUrl?"Site: "+g.siteUrl+".":"",
 g.campaignName?"Nome da campanha: "+g.campaignName+".":"",
 g.start?"Data inicial: "+g.start+".":"Iniciar após ativação manual.",
 g.end?"Data final: "+g.end+".":"Sem data final.",
 g.text?"Texto principal: "+g.text+".":"Sugerir um texto profissional com apenas fatos fornecidos.",
 g.headline?"Título: "+g.headline+".":"",
 g.notes?"Observações: "+g.notes+".":"",
 "Criar um anúncio pausado por criativo, todos dentro do mesmo conjunto. Nunca ativar automaticamente."
].filter(Boolean).join("\n"));
const statusLabel: Record<string, string> = {
  DRAFTED: "Rascunho",
  EXECUTING: "Criando…",
  CREATED: "Criada (pausada)",
  FAILED: "Falhou",
  DISCARDED: "Descartada",
};
const statusTone: Record<string, string> = {
  DRAFTED: "muted", EXECUTING: "warn", CREATED: "ok", FAILED: "bad", DISCARDED: "muted",
};
const destinationLabel: Record<string, string> = {
  WHATSAPP: "WhatsApp", SITE: "Site", LEAD_FORM: "Formulário nativo", POST: "Publicação turbinada",
};
const objectiveLabel: Record<string, string> = {
  OUTCOME_LEADS: "Leads", OUTCOME_TRAFFIC: "Tráfego", OUTCOME_ENGAGEMENT: "Engajamento",
  OUTCOME_SALES: "Vendas", OUTCOME_AWARENESS: "Reconhecimento",
};

function money(v: unknown) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(Number(v || 0));
}
function dateTime(v: unknown) {
  return v ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(v))) : "—";
}

const errorMessages: Record<string, string> = {
  prompt_too_short: "Descreva melhor o pedido (mínimo de uma frase completa).",
  rate_limited: "Limite de pedidos por hora atingido. Aguarde um pouco.",
  client_churned: "Cliente churned não recebe campanha nova.",
  forbidden: "Esse cliente não está na sua carteira.",
  guided_invalid: "As opções da Configuração guiada estão incompletas ou inválidas.",
  planner_incomplete: "A IA devolveu um plano incompleto. Nenhum rascunho inválido foi salvo. Tente novamente.",
  planner_failed: "Falha ao consultar a IA. Confira o serviço e tente novamente.",
  planner_not_configured: "A chave de IA do Campaign Builder ainda não está configurada no servidor. A gestão precisa cadastrar OPENAI_API_KEY.",
  too_many_creatives: "Selecione até 10 imagens ou vídeos por campanha.",
  draft_expired: "O rascunho expirou. Gere o plano de novo.",
  assets_missing: "Conta de anúncio ou Página não cadastradas em Ativos Meta.",
  creative_missing: "Anexe o criativo antes de criar.",
  budget_missing: "Defina o orçamento diário antes de criar.",
  site_url_missing: "Informe a URL do site.",
  lead_form_missing: "Crie ou selecione o formulário nativo antes de confirmar a campanha.",
  meta_token_missing: "Token de escrita da Meta não configurado. Avise a gestão.",
  meta_write_permission_missing: "O token da agência não tem permissão de escrita (ads_management).",
  meta_account_access_missing: "O token da agência não acessa a conta de anúncio deste cliente.",
  file_too_large: "Arquivo acima de 25 MB. Comprima ou use outra versão.",
  unsupported_file_type: "Só imagem ou vídeo.",
  confirmation_required: "Digite CRIAR para confirmar.",
};
function friendlyError(body: Row | null, fallback: string) {
  const key = String(body?.error || "");
  if (errorMessages[key]) return errorMessages[key];
  if (body?.detail) return `${fallback} (${String(body.detail).slice(0, 180)})`;
  return fallback;
}

export default function CampaignCreatePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [boot, setBoot] = useState<Row | null>(null);
  const [bootError, setBootError] = useState("");
  const [clientName, setClientName] = useState("");
  const [mode, setMode] = useState<"NOVA" | "TURBINAR">("NOVA");
  const [posts, setPosts] = useState<Row | null>(null);
  const [postsLoading, setPostsLoading] = useState(false);
  const [selectedPost, setSelectedPost] = useState<Row | null>(null);
  const [prompt, setPrompt] = useState("");
  const [method,setMethod] = useState<"PROMPT"|"GUIDED">("PROMPT");
  const [guided,setGuided] = useState<Guided>(guidedDefault);
  const [files, setFiles] = useState<File[]>([]);
  const [creatives, setCreatives] = useState<Row[]>([]);
  const [uploadProgress, setUploadProgress] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<Row | null>(null);
  const [draftError, setDraftError] = useState("");
  const [historyDiscardId, setHistoryDiscardId] = useState<string | null>(null);
  const [historyDiscardBusy, setHistoryDiscardBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");
  const [overrides, setOverrides] = useState<Row>({});
  const [confirmWord, setConfirmWord] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<Row | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  }, []);

  const api = useCallback(async (payload: Row) => {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${session?.access_token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.ok, status: response.status, body };
  }, [session?.access_token]);

  const loadBoot = useCallback(async () => {
    if (!session?.access_token) return;
    setBootError("");
    const { ok, body } = await api({ action: "BOOTSTRAP" });
    if (!ok) { setBootError(friendlyError(body, "Não foi possível carregar a tela.")); return; }
    setBoot(body);
  }, [api, session?.access_token]);

  useEffect(() => { loadBoot(); }, [loadBoot]);

  const selectedClient = useMemo(
    () => (boot?.clients || []).find((c: Row) => c.display_name === clientName) || null,
    [boot, clientName],
  );

  const changeGuided=(key:keyof Guided,value:string)=>{
    setGuided((old)=>({...old,[key]:value,...(key==="objective"?{destination:value==="OUTCOME_TRAFFIC"?"SITE":"LEAD_FORM"}:{})}));
    setDraft(null);setDraftError("");setOverrides({});setConfirmWord("");setResult(null);
  };
  const resetFlow = () => {
    setDraft(null); setDraftError(""); setOverrides({}); setConfirmWord(""); setResult(null);
  };

  const loadPosts = useCallback(async (name: string) => {
    setPosts(null); setSelectedPost(null);
    if (!name) return;
    setPostsLoading(true);
    try {
      const { ok, body } = await api({ action: "LIST_POSTS", client_name: name });
      setPosts(ok ? body : { facebook: [], instagram: [], errors: { facebook: friendlyError(body, "Falha ao listar publicações.") } });
    } finally {
      setPostsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (mode === "TURBINAR" && clientName) loadPosts(clientName);
  }, [mode, clientName, loadPosts]);

  const generate = async () => {
    const useGuided=mode==="NOVA"&&method==="GUIDED";
    const effectivePrompt=useGuided?guidedToPrompt(guided):prompt.trim();
    if (!session?.access_token || !clientName || drafting) return;
    if(useGuided){
      const validation=guidedValidate(guided);
      if(validation){setDraftError(validation);return;}
    }else if(effectivePrompt.length<15){setDraftError("Descreva a campanha em uma frase completa.");return;}
    if (mode === "TURBINAR" && !selectedPost) { setDraftError("Escolha a publicação que vai turbinar."); return; }
    setDrafting(true); setDraftError(""); setDraft(null); setResult(null); setOverrides({}); setConfirmWord("");
    try {
      let creativePayloads = creatives;
      if (mode === "NOVA" && files.length > 10) {
        setDraftError("Selecione até 10 arquivos.");
        return;
      }
      if (mode === "NOVA" && files.length && creatives.length !== files.length) {
        const uploaded: Row[] = [];
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file.size > 25 * 1024 * 1024 || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) {
            setDraftError(`Arquivo inválido ou acima de 25 MB: ${file.name}`);
            return;
          }
          setUploadProgress(`Enviando ${i + 1} de ${files.length}: ${file.name}`);
          const form = new FormData();
          form.set("action", "UPLOAD_CREATIVE");
          form.set("client_name", clientName);
          form.set("file", file);
          const response = await fetch(API_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}` },
            body: form,
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || !body?.ok) {
            setDraftError(`${file.name}: ${friendlyError(body, "Falha no upload do criativo.")}`);
            return;
          }
          uploaded.push(body.creative);
        }
        setCreatives(uploaded);
        creativePayloads = uploaded;
      }
      const { ok, body } = await api({
        action: "DRAFT",
        client_name: clientName,
        prompt: effectivePrompt,
        guided: useGuided ? guided : null,
        creatives: mode === "NOVA" ? creativePayloads : [],
        boost: mode === "TURBINAR" && selectedPost ? {
          source: selectedPost.source,
          post_id: selectedPost.post_id,
          permalink: selectedPost.permalink,
          caption: selectedPost.caption,
        } : null,
      });
      if (!ok) { setDraftError(friendlyError(body, "Não foi possível gerar o plano.")); return; }
      setDraft(body);
    } catch (error) {
      setDraftError(`Erro de rede ao gerar o plano: ${String((error as Error)?.message || error).slice(0,160)}`);
    } finally {
      setDrafting(false);
      setUploadProgress("");
    }
  };

  const execute = async () => {
    if (!draft?.request_id || executing) return;
    if (confirmWord.trim().toUpperCase() !== "CRIAR") { setDraftError("Digite CRIAR para confirmar."); return; }
    setExecuting(true); setDraftError("");
    try {
      const { ok, body } = await api({ action: "EXECUTE", request_id: draft.request_id, confirmation: "CRIAR", overrides });
      if (!ok) { setDraftError(friendlyError(body, "A criação falhou. Nenhuma campanha foi ativada; revise o histórico e os itens pausados na Meta.")); await loadBoot(); return; }
      setResult(body);
      setDraft(null); setPrompt(""); setFiles([]); setCreatives([]); setConfirmWord("");
      if (fileRef.current) fileRef.current.value = "";
      await loadBoot();
    } finally {
      setExecuting(false);
    }
  };

  const discard = async () => {
    if (!draft?.request_id) return;
    try {
      const { ok, body } = await api({ action: "DISCARD", request_id: draft.request_id });
      if (!ok) { setDraftError(friendlyError(body, "Não foi possível descartar o rascunho.")); return; }
      resetFlow();
      await loadBoot();
    } catch (error) {
      setDraftError(`Falha de conexão ao descartar: ${String((error as Error)?.message || error).slice(0, 160)}`);
    }
  };

  const discardFromHistory = async (requestId: string) => {
    if (historyDiscardBusy || historyDiscardId !== requestId) return;
    setHistoryDiscardBusy(true); setHistoryError(""); setHistoryNotice("");
    try {
      const { ok, body } = await api({ action: "DISCARD", request_id: requestId });
      if (!ok) { setHistoryError(friendlyError(body, "Não foi possível descartar este rascunho.")); return; }
      if (draft?.request_id === requestId) resetFlow();
      setHistoryDiscardId(null);
      setHistoryNotice("Rascunho descartado. Nenhuma campanha foi criada ou alterada na Meta.");
      await loadBoot();
    } catch (error) {
      setHistoryError(`Falha de conexão: ${String((error as Error)?.message || error).slice(0, 160)}`);
    } finally {
      setHistoryDiscardBusy(false);
    }
  };

  const plan = draft?.plan as Row | undefined;
  const ov = (key: string, fallback: unknown) => (overrides[key] != null && overrides[key] !== "" ? overrides[key] : fallback ?? "");
  const setOv = (key: string, value: string) => setOverrides((prev: Row) => ({ ...prev, [key]: value }));

  if (!ready) return null;

  return (
    <main className="cb-page">
      <style>{`
        .cb-page{min-height:100vh;background:#050c14;color:#dbe7f1;font-family:Inter,system-ui,sans-serif;padding:26px 20px 80px;display:flex;flex-direction:column;gap:18px;align-items:center}
        .cb-shell{width:100%;max-width:980px;display:flex;flex-direction:column;gap:16px}
        .cb-head h1{margin:0;font-size:22px;font-weight:900;color:#fff}
        .cb-head p{margin:6px 0 0;font-size:13px;color:#8aa2b6;max-width:680px;line-height:1.5}
        .cb-card{background:rgba(10,22,36,.86);border:1px solid #16304a;border-radius:16px;padding:18px}
        .cb-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .cb-field{display:flex;flex-direction:column;gap:6px}
        .cb-field.full{grid-column:1 / -1}
        .cb-field label{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#7e97ab}
        .cb-field select,.cb-field input,.cb-field textarea{background:#08131f;border:1px solid #1d3a55;border-radius:10px;color:#e9f3fb;padding:10px 12px;font-size:14px;font-family:inherit}
        .cb-field textarea{min-height:110px;resize:vertical;line-height:1.5}
        .cb-field select:focus,.cb-field input:focus,.cb-field textarea:focus{outline:none;border-color:#f26b21}
        .cb-hint{font-size:12px;color:#7e97ab}
        .cb-asset-flags{display:flex;gap:8px;flex-wrap:wrap}
        .cb-pill{display:inline-flex;align-items:center;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;border:1px solid transparent}
        .cb-pill.ok{color:#8ef2b7;background:rgba(32,160,96,.14);border-color:#1f5c3c}
        .cb-pill.bad{color:#ff9d9d;background:rgba(190,40,40,.16);border-color:#6e2424}
        .cb-pill.warn{color:#ffd28a;background:rgba(220,140,30,.14);border-color:#6e4d1b}
        .cb-pill.muted{color:#9fb3c4;background:rgba(120,150,180,.1);border-color:#28445e}
        .cb-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        .cb-btn{border:none;border-radius:10px;padding:11px 18px;font-size:13px;font-weight:900;cursor:pointer;transition:.15s ease;font-family:inherit}
        .cb-btn.primary{background:linear-gradient(135deg,#f26b21,#d4541a);color:#fff}
        .cb-btn.primary:hover{filter:brightness(1.1)}
        .cb-btn.primary:disabled{opacity:.45;cursor:not-allowed}
        .cb-btn.ghost{background:transparent;color:#9fb3c4;border:1px solid #28445e}
        .cb-btn.ghost:hover{color:#fff;border-color:#3d618a}
        .cb-error{background:rgba(190,40,40,.14);border:1px solid #6e2424;color:#ffb4b4;border-radius:10px;padding:10px 14px;font-size:13px}
        .cb-success{background:rgba(32,160,96,.12);border:1px solid #1f5c3c;color:#a9f5c9;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.5}
        .cb-plan-section{border-top:1px solid #16304a;margin-top:14px;padding-top:14px}
        .cb-plan-section h3{margin:0 0 10px;font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#f26b21}
        .cb-kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:13px}
        .cb-kv span{color:#7e97ab}
        .cb-kv b{color:#e9f3fb;font-weight:600}
        .cb-warnings{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
        .cb-warnings li{font-size:13px;color:#ffd28a;background:rgba(220,140,30,.1);border:1px solid #6e4d1b;border-radius:8px;padding:8px 12px}
        .cb-assumptions li{font-size:12px;color:#9fb3c4}
        .cb-history{display:flex;flex-direction:column;gap:10px}
        .cb-history-item{display:flex;flex-direction:column;gap:6px;border:1px solid #16304a;border-radius:12px;padding:12px 14px;background:rgba(8,18,30,.7)}
        .cb-history-top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
        .cb-history-top b{font-size:13px;color:#fff}
        .cb-history-item small{font-size:12px;color:#7e97ab;line-height:1.45}
        .cb-history-item .prompt{font-style:italic;color:#9fb3c4}
        .cb-history-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
        .cb-history-actions button{border:1px solid #37536d;border-radius:8px;background:transparent;color:#bcd1df;padding:7px 10px;font-family:inherit;font-weight:700;font-size:12px;cursor:pointer}
        .cb-history-actions button:hover{border-color:#fa975e;color:#fff}
        .cb-history-actions button.danger{border-color:#a04545;color:#ffb4b4}
        .cb-history-actions button:disabled{opacity:.5;cursor:not-allowed}
        .cb-confirm{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
        .cb-confirm input{background:#08131f;border:1px solid #1d3a55;border-radius:10px;color:#e9f3fb;padding:10px 12px;font-size:14px;width:130px;text-transform:uppercase;font-family:inherit}
        .cb-mode{display:flex;gap:8px;margin-bottom:14px}
        .cb-mode button{flex:1;border-radius:10px;border:1px solid #28445e;background:transparent;color:#9fb3c4;padding:10px 14px;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;transition:.15s ease}
        .cb-mode button.active{background:linear-gradient(135deg,rgba(242,107,33,.22),rgba(80,190,255,.1));border-color:#b85b28;color:#fff}
        .cb-posts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:8px}
        .cb-post{display:flex;flex-direction:column;gap:6px;border:1px solid #1d3a55;border-radius:12px;padding:8px;background:#08131f;cursor:pointer;text-align:left;font-family:inherit;transition:.15s ease}
        .cb-post:hover{border-color:#3d618a}
        .cb-post.selected{border-color:#f26b21;box-shadow:0 0 0 1px #f26b21}
        .cb-post img{width:100%;height:96px;object-fit:cover;border-radius:8px;background:#0d1b2c}
        .cb-post .noimg{width:100%;height:96px;border-radius:8px;background:#0d1b2c;display:flex;align-items:center;justify-content:center;color:#52708c;font-size:11px}
        .cb-post small{font-size:11px;color:#9fb3c4;line-height:1.35;max-height:44px;overflow:hidden}
        .cb-post .net{font-size:10px;font-weight:900;letter-spacing:.06em;color:#7e97ab}

        .cb-methods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:14px 0}
        .cb-methods button{background:#091826;border:1px solid #25445c;color:#9eb9cd;border-radius:12px;padding:13px 15px;text-align:left;cursor:pointer;font:800 14px inherit}
        .cb-methods button.chosen{background:rgba(242,107,33,.12);border-color:#f26b21;color:#fff}
        .cb-methods small{display:block;font-size:11px;color:#9db3c6;font-weight:500;margin-top:5px}
        .cb-guided{margin-top:16px;display:grid;gap:12px}
        .cb-guide-section{padding:16px;border:1px solid #1b3d58;border-radius:12px;background:rgba(5,17,30,.65)}
        .cb-guide-section h3{margin:0 0 14px;font-size:14px;color:#eef7ff}
        @media(max-width:760px){.cb-methods{grid-template-columns:1fr}}
        @media (max-width:760px){.cb-grid{grid-template-columns:1fr}.cb-kv{grid-template-columns:1fr}}
      `}</style>
      <div className="cb-shell">
        <header className="cb-head">
          <h1>Criar Campanha</h1>
          <p>Crie campanhas descrevendo um pedido para a IA ou escolhendo opções na Configuração guiada. Você revisa o plano antes de criar e tudo permanece <b>pausado</b> na conta do cliente.</p>
        </header>

        {bootError && <div className="cb-error">{bootError}</div>}
        {boot && boot.planner_configured === false && (
          <div className="cb-error">
            A IA do Campaign Builder ainda não está configurada: falta a secret OPENAI_API_KEY no Supabase.
            Nenhuma imagem será enviada enquanto o planejador estiver indisponível.
            Depois de cadastrar a chave, atualize a página.
          </div>
        )}
        {result && (
          <div className="cb-success">
            <b>Campanha criada pausada: {result.campaign_name}</b><br />
            IDs — campanha {result.campaign_id} · conjunto {result.adset_id} · anúncios {(result.ad_ids || [result.ad_id]).join(", ")}.<br />
            Revise no Gerenciador de Anúncios e ative quando estiver tudo certo.
          </div>
        )}

        <section className="cb-card">
          <div className="cb-mode">
            <button className={mode === "NOVA" ? "active" : ""} onClick={() => { setMode("NOVA"); resetFlow(); }}>Campanha nova</button>
            <button className={mode === "TURBINAR" ? "active" : ""} onClick={() => { setMode("TURBINAR"); resetFlow(); }}>Turbinar publicação</button>
          </div>

          {mode==="NOVA"&&<div className="cb-methods" role="group" aria-label="Forma de configurar campanha">
            <button type="button" className={method==="PROMPT"?"chosen":""} onClick={()=>{setMethod("PROMPT");resetFlow();}}>
              Criar com IA <small>Descreva sua campanha</small>
            </button>
            <button type="button" className={method==="GUIDED"?"chosen":""} onClick={()=>{setMethod("GUIDED");resetFlow();}}>
              Configuração guiada <small>Escolha as opções</small>
            </button>
          </div>}
          <div className="cb-grid">
            <div className="cb-field">
              <label>Cliente</label>
              <select value={clientName} onChange={(e) => { setClientName(e.target.value); resetFlow(); setCreatives([]); setFiles([]); if (fileRef.current) fileRef.current.value = ""; }}>
                <option value="">Selecione…</option>
                {(boot?.clients || []).map((c: Row) => (
                  <option key={c.id} value={c.display_name}>{c.display_name}</option>
                ))}
              </select>
              {selectedClient && (
                <div className="cb-asset-flags">
                  <span className={`cb-pill ${selectedClient.has_ad_account ? "ok" : "bad"}`}>{selectedClient.has_ad_account ? "Conta de anúncio OK" : "Sem conta de anúncio"}</span>
                  <span className={`cb-pill ${selectedClient.has_page ? "ok" : "bad"}`}>{selectedClient.has_page ? "Página OK" : "Sem Página cadastrada"}</span>
                </div>
              )}
              {selectedClient && (!selectedClient.has_ad_account || !selectedClient.has_page) && (
                <span className="cb-hint">Preencha os Ativos Meta do cliente (card Ativos Meta) antes de criar.</span>
              )}
            </div>
            {mode === "NOVA" ? (
              <div className="cb-field">
                <label>Criativos (até 10 arquivos, 25 MB cada)</label>
                <input ref={fileRef} type="file" accept="image/*,video/*" multiple onChange={(e) => {
                  setFiles(Array.from(e.target.files || []));
                  setCreatives([]);
                  resetFlow();
                }} />
                {files.length > 0 && (
                  <div className="cb-hint" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <b>{files.length} arquivo(s) selecionado(s) — cada um será um anúncio pausado</b>
                    {files.map((item, i) => <span key={`${item.name}-${i}`}>{i + 1}. {item.name} · {(item.size / 1024 / 1024).toFixed(1)} MB</span>)}
                  </div>
                )}
              </div>
            ) : (
              <div className="cb-field">
                <label>Publicação selecionada</label>
                <span className="cb-hint">{selectedPost ? `${selectedPost.source === "INSTAGRAM" ? "Instagram" : "Facebook"} · ${(selectedPost.caption || "(sem legenda)").slice(0, 70)}` : "Escolha uma publicação abaixo."}</span>
              </div>
            )}
            {(mode==="TURBINAR"||method==="PROMPT")&&<div className="cb-field full">
              <label>Pedido para a IA</label>
              <textarea value={prompt} onChange={(ev)=>{setPrompt(ev.target.value);resetFlow();}}
                placeholder='Ex.: campanha de leads no litoral norte, R$ 20/dia, formulário instantâneo, com meus criativos.'/>
            </div>}
          </div>

          {mode==="NOVA"&&method==="GUIDED"&&<div className="cb-guided">
            <section className="cb-guide-section">
              <h3>1. Objetivo e produto</h3>
              <div className="cb-grid">
                <div className="cb-field"><label>Objetivo</label><select value={guided.objective} onChange={ev=>changeGuided("objective",ev.target.value)}>
                  <option value="OUTCOME_LEADS">Captar leads</option><option value="OUTCOME_TRAFFIC">Tráfego para site</option>
                </select></div>
                <div className="cb-field"><label>Destino</label><select value={guided.destination} onChange={ev=>changeGuided("destination",ev.target.value)}>
                  {guided.objective==="OUTCOME_LEADS"?<><option value="LEAD_FORM">Formulário da Meta</option><option value="WHATSAPP">WhatsApp</option></>:<option value="SITE">Landing page / site</option>}
                </select></div>
                <div className="cb-field full"><label>Imóvel ou empreendimento</label><input maxLength={120} value={guided.product} onChange={ev=>changeGuided("product",ev.target.value)} placeholder="Ex.: AP Martim Praia Clube"/></div>
                <div className="cb-field full"><label>Nome da campanha (opcional)</label><input maxLength={120} value={guided.campaignName} onChange={ev=>changeGuided("campaignName",ev.target.value)} placeholder="Deixe vazio para a IA sugerir"/></div>
              </div>
            </section>
            <section className="cb-guide-section">
              <h3>2. Orçamento e público</h3>
              <div className="cb-grid">
                <div className="cb-field"><label>Orçamento diário total (R$)</label><input type="number" min="1" max="100000" value={guided.budget} onChange={ev=>changeGuided("budget",ev.target.value)}/></div>
                <div className="cb-field"><label>Interesse principal</label><select value={guided.intent} onChange={ev=>changeGuided("intent",ev.target.value)}>
                  <option value="TODOS">Moradia e investimento</option><option value="MORADIA">Moradia</option><option value="INVESTIMENTO">Investimento</option>
                </select></div>
                <div className="cb-field full"><label>Cidades ou regiões</label><input maxLength={300} value={guided.cities} onChange={ev=>changeGuided("cities",ev.target.value)} placeholder="Ex.: Caraguatatuba; São Sebastião"/>
                  <span className="cb-hint">Separe as cidades por ponto e vírgula. Respeitar restrições de anúncios imobiliários da Meta.</span></div>
                <div className="cb-field"><label>Raio em km (opcional)</label><input type="number" min="1" max="80" value={guided.radius} onChange={ev=>changeGuided("radius",ev.target.value)} placeholder="Padrão da Meta"/></div>
              </div>
            </section>
            <section className="cb-guide-section">
              <h3>3. Contato e período</h3>
              <div className="cb-grid">
                {guided.destination==="LEAD_FORM"&&<div className="cb-field full"><label>ID do formulário Meta (opcional para gerar plano)</label><input inputMode="numeric" value={guided.formId} onChange={ev=>changeGuided("formId",ev.target.value)} placeholder="ID do formulário já existente"/><span className="cb-hint">Você poderá criar um formulário com perguntas diretamente na revisão do plano, sem precisar procurar o ID na Meta.</span></div>}
                {guided.destination==="SITE"&&<div className="cb-field full"><label>Link da landing page</label><input type="url" value={guided.siteUrl} onChange={ev=>changeGuided("siteUrl",ev.target.value)} placeholder="https://..."/></div>}
                <div className="cb-field"><label>Início (opcional)</label><input type="date" value={guided.start} onChange={ev=>changeGuided("start",ev.target.value)}/></div>
                <div className="cb-field"><label>Fim (opcional)</label><input type="date" value={guided.end} onChange={ev=>changeGuided("end",ev.target.value)}/></div>
              </div>
            </section>
            <section className="cb-guide-section">
              <h3>4. Texto do anúncio</h3>
              <div className="cb-grid">
                <div className="cb-field full"><label>Texto principal (opcional)</label><textarea maxLength={900} value={guided.text} onChange={ev=>changeGuided("text",ev.target.value)} placeholder="Deixe vazio para a IA sugerir"/></div>
                <div className="cb-field full"><label>Título (opcional)</label><input maxLength={60} value={guided.headline} onChange={ev=>changeGuided("headline",ev.target.value)} placeholder="Título curto do anúncio"/></div>
                <div className="cb-field full"><label>Observações (opcional)</label><textarea maxLength={800} value={guided.notes} onChange={ev=>changeGuided("notes",ev.target.value)} placeholder="Detalhes importantes e perguntas que deseja no formulário"/></div>
              </div>
            </section>
            <div className="cb-hint">A IA prepara a proposta e as escolhas são aplicadas ao plano no servidor. Cada criativo vira um anúncio pausado dentro do mesmo conjunto, sem duplicar o orçamento.</div>
          </div>}
          {mode === "TURBINAR" && clientName && (
            <div style={{ marginTop: 12 }}>
              {postsLoading && <span className="cb-hint">Buscando publicações…</span>}
              {!postsLoading && posts && (
                <>
                  {posts.errors?.facebook && !(posts.facebook || []).length && <span className="cb-hint">Facebook: {posts.errors.facebook}</span>}
                  {posts.errors?.instagram && !(posts.instagram || []).length && <span className="cb-hint"> · Instagram: {posts.errors.instagram}</span>}
                  <div className="cb-posts">
                    {[...(posts.instagram || []), ...(posts.facebook || [])].map((p: Row) => (
                      <button key={`${p.source}-${p.post_id}`} type="button" className={`cb-post${selectedPost?.post_id === p.post_id ? " selected" : ""}`} onClick={() => { setSelectedPost(p); resetFlow(); }}>
                        {p.picture ? <img src={p.picture} alt="" loading="lazy" /> : <div className="noimg">sem prévia</div>}
                        <span className="net">{p.source === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK"}{p.created_at ? ` · ${dateTime(p.created_at).split(",")[0]}` : ""}</span>
                        <small>{p.caption || "(sem legenda)"}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="cb-actions" style={{ marginTop: 12 }}>
            <button className="cb-btn primary" disabled={!clientName || (mode==="TURBINAR"||method==="PROMPT" ? prompt.trim().length<15 : false) || drafting || boot?.planner_configured===false || (mode==="TURBINAR" && !selectedPost)} onClick={generate}>
              {drafting ? (uploadProgress || "Gerando plano…") : draft ? "Gerar de novo" : "Gerar plano"}
            </button>
            {draft && <button className="cb-btn ghost" onClick={discard}>Descartar rascunho</button>}
          </div>
          {draftError && <div className="cb-error" style={{ marginTop: 12 }}>{draftError}</div>}

          {draft && plan && (
            <>
              <div className="cb-plan-section">
                <h3>Campanha</h3>
                <div className="cb-grid">
                  <div className="cb-field"><label>Nome</label><input value={ov("campaign_name", plan.campaign?.name)} onChange={(e) => setOv("campaign_name", e.target.value)} /></div>
                  <div className="cb-field"><label>Objetivo</label><input value={objectiveLabel[plan.campaign?.objective] || plan.campaign?.objective || ""} disabled /></div>
                </div>
              </div>
              <div className="cb-plan-section">
                <h3>Conjunto</h3>
                <div className="cb-grid">
                  <div className="cb-field"><label>Nome</label><input value={ov("adset_name", plan.adset?.name)} onChange={(e) => setOv("adset_name", e.target.value)} /></div>
                  <div className="cb-field"><label>Orçamento diário (R$)</label><input type="number" min={1} value={ov("daily_budget_brl", plan.adset?.daily_budget_brl || "")} onChange={(e) => setOv("daily_budget_brl", e.target.value)} /></div>
                </div>
                <div className="cb-kv" style={{ marginTop: 10 }}>
                  <span>Destino</span><b>{destinationLabel[plan.adset?.destination?.type] || plan.adset?.destination?.type}</b>
                  <span>Localização</span><b>{(plan.geo_resolved || []).length ? (plan.geo_resolved || []).map((g: Row) => g.name).join(", ") : "Brasil (ampla)"}{plan.adset?.geo?.radius_km ? ` · raio ${plan.adset.geo.radius_km} km` : ""}</b>
                  <span>Idade</span><b>{plan.adset?.age_min} a {plan.adset?.age_max} anos{plan.adset?.genders !== "all" ? ` · ${plan.adset?.genders === "male" ? "homens" : "mulheres"}` : ""}</b>
                  <span>Início</span><b>{plan.adset?.start === "NOW" ? "Imediato (pausada até você ativar)" : plan.adset?.start}{plan.adset?.end ? ` · termina ${plan.adset.end}` : ""}</b>
                </div>
                {plan.adset?.destination?.type === "SITE" && (
                  <div className="cb-field" style={{ marginTop: 10 }}><label>URL do site</label><input value={ov("site_url", plan.adset?.destination?.url || "")} onChange={(e) => setOv("site_url", e.target.value)} placeholder="https://…" /></div>
                )}
                {plan.adset?.destination?.type === "LEAD_FORM" && (
                  <div style={{ marginTop: 12 }}>
                    <div className="cb-field"><label>Formulário da Meta (criar aqui ou selecionar existente)</label>
                      <input value={ov("lead_form_id", plan.adset?.destination?.lead_form_id || "")} onChange={(e) => setOv("lead_form_id", e.target.value)} placeholder="ID preenchido automaticamente ao selecionar ou criar" />
                      <span className="cb-hint">Você não precisa localizar um ID: escolha um formulário pelo nome ou crie as perguntas nesta tela.</span>
                    </div>
                    <LeadFormComposer key={draft.request_id} requestId={draft.request_id} clientName={clientName}
                      api={api} onSelect={(id) => setOv("lead_form_id", id)} />
                  </div>
                )}
              </div>
              <div className="cb-plan-section">
                <h3>Anúncio</h3>
                {draft.mode === "BOOST" ? (
                  <div className="cb-kv">
                    <span>Publicação</span><b>{plan.boost?.source === "INSTAGRAM" ? "Instagram" : "Facebook"} · {(plan.boost?.caption || "(sem legenda)").slice(0, 120)}</b>
                    {plan.boost?.permalink ? <><span>Link</span><b><a href={plan.boost.permalink} target="_blank" rel="noreferrer" style={{ color: "#7fc4ff" }}>abrir publicação</a></b></> : null}
                    <span>Nome do anúncio</span><b><input value={ov("ad_name", plan.ad?.name)} onChange={(e) => setOv("ad_name", e.target.value)} style={{ background: "#08131f", border: "1px solid #1d3a55", borderRadius: 8, color: "#e9f3fb", padding: "6px 10px", fontFamily: "inherit", width: "100%" }} /></b>
                  </div>
                ) : (
                  <>
                    <div className="cb-grid">
                      <div className="cb-field"><label>Nome</label><input value={ov("ad_name", plan.ad?.name)} onChange={(e) => setOv("ad_name", e.target.value)} /></div>
                      <div className="cb-field"><label>Título (headline)</label><input value={ov("headline", plan.ad?.headline)} onChange={(e) => setOv("headline", e.target.value)} /></div>
                      <div className="cb-field full"><label>Texto principal</label><textarea value={ov("primary_text", plan.ad?.primary_text)} onChange={(e) => setOv("primary_text", e.target.value)} /></div>
                    </div>
                    <div className="cb-kv" style={{ marginTop: 10 }}>
                      <span>CTA</span><b>{plan.ad?.cta}</b>
                      <span>Criativos</span><b>{(creatives.length ? creatives.map((c) => c.file_name) : files.map((f) => f.name)).join(", ") || "—"}</b>
                    </div>
                  </>
                )}
              </div>
              {(draft.warnings || []).length > 0 && (
                <div className="cb-plan-section">
                  <h3>Atenção</h3>
                  <ul className="cb-warnings">{(draft.warnings || []).filter((w: string) => !(ov("lead_form_id",plan.adset?.destination?.lead_form_id) && w.includes("ID do formulário"))).map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
                </div>
              )}
              {(plan.questions || []).length > 0 && (
                <div className="cb-plan-section">
                  <h3>A IA ficou em dúvida</h3>
                  <ul className="cb-warnings">{(plan.questions || []).map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>
                  <p className="cb-hint" style={{ marginTop: 8 }}>Responda editando o pedido acima e gere o plano de novo, ou ajuste os campos do preview.</p>
                </div>
              )}
              {(plan.assumptions || []).length > 0 && (
                <div className="cb-plan-section">
                  <h3>O que a IA assumiu</h3>
                  <ul className="cb-assumptions">{(plan.assumptions || []).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
                </div>
              )}
              <div className="cb-plan-section">
                <h3>Confirmar</h3>
                <p className="cb-hint">A campanha, o conjunto e o anúncio serão criados <b>pausados</b> na conta do cliente. Nada roda nem gasta até você ativar no Gerenciador.</p>
                <div className="cb-confirm">
                  <input value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} placeholder="CRIAR" />
                  <button className="cb-btn primary" disabled={executing || confirmWord.trim().toUpperCase() !== "CRIAR"} onClick={execute}>
                    {executing ? "Criando na Meta…" : "Criar campanha pausada"}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="cb-card">
          <h3 style={{ margin: "0 0 12px", fontSize: 12, fontWeight: 900, letterSpacing: ".08em", textTransform: "uppercase", color: "#f26b21" }}>Últimos pedidos</h3>
          {historyError && <div className="cb-error" role="alert" style={{ marginBottom: 12 }}>{historyError}</div>}
          {historyNotice && <div className="cb-success" role="status" style={{ marginBottom: 12 }}>{historyNotice}</div>}
          <div className="cb-history">
            {(boot?.history || []).length === 0 && <span className="cb-hint">Nenhum pedido ainda.</span>}
            {(boot?.history || []).map((h: Row) => {
              const mayDiscard = h.status === "DRAFTED" &&
                (boot?.profile?.is_adler || boot?.profile?.role === "MGMT" ||
                  (Boolean(session?.user?.id) && h.actor_user_id === session?.user?.id));
              const confirming = historyDiscardId === h.id;
              return (
                <article key={h.id} className="cb-history-item">
                  <div className="cb-history-top">
                    <b>{h.client_name || "Cliente"} · {h.plan?.campaign?.name || "Sem plano"}</b>
                    <span className={`cb-pill ${statusTone[h.status] || "muted"}`}>{statusLabel[h.status] || h.status}</span>
                  </div>
                  <small className="prompt">“{String(h.prompt || "").slice(0, 180)}{String(h.prompt || "").length > 180 ? "…" : ""}”</small>
                  <small>
                    {h.actor_person} · {dateTime(h.created_at)}
                    {h.plan?.adset?.daily_budget_brl ? <> · {money(h.plan.adset.daily_budget_brl)}/dia</> : null}
                    {h.created_campaign_id ? <> · campanha {h.created_campaign_id}</> : null}
                    {h.status === "FAILED" && h.error ? <> · {String(h.error).slice(0, 140)}</> : null}
                    {h.status === "DRAFTED" && h.expires_at && Date.parse(h.expires_at) < Date.now() ? <> · prazo expirado</> : null}
                  </small>
                  {mayDiscard && (
                    <div className="cb-history-actions">
                      {!confirming ? (
                        <button type="button" disabled={historyDiscardBusy}
                          onClick={() => { setHistoryDiscardId(h.id); setHistoryError(""); setHistoryNotice(""); }}>
                          Descartar rascunho
                        </button>
                      ) : (
                        <>
                          <span className="cb-hint">Descartar somente este rascunho? O histórico será preservado.</span>
                          <button type="button" className="danger" disabled={historyDiscardBusy}
                            onClick={() => void discardFromHistory(h.id)}>
                            {historyDiscardBusy ? "Descartando…" : "Confirmar descarte"}
                          </button>
                          <button type="button" disabled={historyDiscardBusy} onClick={() => setHistoryDiscardId(null)}>
                            Cancelar
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
