"use client";

// Criar Campanha — o GT descreve a campanha em texto livre, a IA monta o plano
// (campanha + conjunto + anúncio), o GT revisa o preview, ajusta e confirma.
// Tudo é criado PAUSADO na conta do cliente via agency-ops-campaign-builder-api.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import LeadFormComposer from "./lead-form-composer";
import MakeOnlyPanel from "./make-only-panel";
import PortfolioAuditPanel from "./portfolio-audit-panel";

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
  CREATED: "Criada na Meta",
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
  draft_expired: "Rascunho expirado. Clique em Retomar para renovar o prazo.",
  draft_incomplete: "Este rascunho contém dados incompletos. Gere um novo plano válido antes de criar.",
  assets_changed: "A conta de anúncios ou Página do cliente mudou desde a criação do rascunho. Gere outro plano.",
  request_already_executed: "Este pedido já foi criado na Meta. Não é possível executá-lo novamente.",
  request_not_resumable: "A tentativa não pode ser retomada automaticamente porque pode haver objetos na Meta. Confira os IDs no histórico antes de fazer outra campanha.",
  request_not_draft: "Esta tentativa já saiu do estado de rascunho. Não clique novamente em Criar: use Retomar tentativa para recuperar os criativos e revalidar o plano antes de tentar de novo.",
  request_not_found: "Esta tentativa não foi encontrada no servidor. Atualize Últimos pedidos antes de continuar.",
  assets_missing: "Conta de anúncio ou Página não cadastradas em Ativos Meta.",
  creative_missing: "Anexe o criativo antes de criar.",
  budget_missing: "Defina o orçamento diário antes de criar.",
  site_url_missing: "Informe a URL do site.",
  lead_form_missing: "Crie ou selecione o formulário nativo antes de confirmar a campanha.",
  lead_form_read_denied: "Não foi possível consultar o formulário na Meta. Confira as permissões da Página e de leads.",
  lead_form_page_mismatch: "O formulário informado pertence a outra Página do Facebook. Selecione o da Página deste cliente.",
  lead_form_not_active: "O formulário está arquivado, em rascunho ou indisponível. Selecione um formulário ATIVO.",
  execution_failed: "A Meta recusou uma etapa da criação. Confira abaixo a causa antes de tentar novamente.",
  campaign_created_persistence_failed: "A Meta criou objetos, mas o registro local falhou. Não crie de novo; verifique os IDs no histórico.",
  meta_token_missing: "Token de escrita da Meta não configurado. Avise a gestão.",
  meta_write_permission_missing: "O token da agência não tem permissão de escrita (ads_management).",
  meta_account_access_missing: "O token da agência não acessa a conta de anúncio deste cliente.",
  file_too_large: "Arquivo acima de 25 MB. Comprima ou use outra versão.",
  unsupported_file_type: "Só imagem ou vídeo.",
  confirmation_required: "A confirmação de criação não foi reconhecida. Clique em Criar campanha novamente, sem digitar nenhuma palavra.",
  activation_confirmation_required: "Digite ATIVAR para confirmar a campanha.",
  campaign_not_created: "Somente campanhas realmente criadas na Meta podem ser ativadas.",
  activation_ids_missing: "Faltam IDs reais de campanha, conjunto ou anuncio. A ativacao foi bloqueada.",
  activation_link_mismatch: "Os objetos na Meta nao correspondem aos IDs criados neste pedido.",
  activation_untracked_objects: "A estrutura na Meta tem conjuntos ou anuncios que nao foram criados neste pedido. Confira antes de ativar.",
  activation_structure_check_failed: "Nao foi possivel conferir todos os conjuntos e anuncios da campanha na Meta.",
  activation_budget_changed: "O orcamento na Meta mudou desde a criacao. Confirme pelo Gerenciador antes de ativar.",
  activation_end_date_passed: "O conjunto de anuncios ja passou da data de termino.",
  campaign_state_not_toggleable: "A campanha, conjunto ou algum anuncio nao permite ativacao.",
  currency_mismatch: "A moeda da conta Meta nao corresponde ao orcamento em reais.",
  meta_account_not_active: "A conta de anuncios nao esta ativa na Meta.",
  assets_changed: "A conta de anúncio ou a Página deste cliente mudou (ou ficou divergente) depois do rascunho. Confira Ativos Meta e gere o plano de novo.",
  qa_activation_forbidden: "Campanhas de homologação (QA) nunca podem ser ativadas.",
  qa_forbidden: "Somente o perfil admin pode rodar a homologação.",
  qa_already_exists: "Já existe um teste de homologação para este cliente nesta rodada.",
  activation_failed: "Falha ao ativar. Verifique a auditoria e os status reais na Meta.",
  geo_unresolved: "A Meta não confirmou uma ou mais cidades. Informe o nome e a UF (ex.: Praia Grande, SP) e confira o público antes de criar.",
  geo_conflict: "O público contém uma região estadual e municípios dentro dela. Revise a localização antes de criar.",
  geo_recheck_unavailable: "Não foi possível revalidar as cidades na Meta. O rascunho e os criativos foram preservados.",
  lead_form_external_link_missing: "Anúncios de formulário precisam de um link externo. Cadastre o site na Página do cliente ou informe a URL do site no preview.",
  make_delivery_not_configured: "Entrega via Make indisponível: a credencial do Make ainda não está configurada no servidor.",
  make_fb_connection_missing: "Não há conexão do Facebook Lead Ads cadastrada para o GT responsável por este cliente. A gestão precisa vincular a conexão do Make desse GT antes de usar a entrega automática.",
  make_delivery_requires_form: "O envio via Make só funciona com destino Formulário nativo.",
  make_product_required: "Informe o nome do produto que aparecerá no título NOVO LEAD (mínimo 3 letras).",
  make_recipient_invalid: "Número do destinatário inválido. Use 55 + DDD + número, somente dígitos.",
  make_roleta_recipients_invalid: "Roleta inválida: informe de 2 a 25 corretores, com nome e WhatsApp válidos e sem números repetidos.",
  make_delivery_not_requested: "Este pedido foi criado sem entrega via Make.",
  make_delivery_not_ready: "A entrega de leads no Make ainda não está pronta. Configure ou repare a automação antes de ativar.",
  make_delivery_manual_recovery_required: "Já existe um cenário ou webhook parcialmente criado no Make para este pedido. Confira no Make antes de tentar de novo.",
  make_delivery_form_changed: "O formulário ou a Página mudaram desde a criação. Não é seguro configurar a automação.",
  make_delivery_form_already_routed: "Este formulário já tem uma automação ativa com outro destinatário. Reaproveite a existente ou use outro formulário.",
  make_form_questions_missing: "O formulário não devolveu as perguntas (nome, telefone, e-mail). Não é possível montar a mensagem.",
  make_delivery_already_processing: "A configuração do Make já está em andamento para este pedido. Aguarde e recarregue o histórico.",
  make_delivery_audit_failed: "O cenário foi criado no Make, mas o registro local falhou. Não crie outro: anote o número do cenário.",
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
  const [metaAccess, setMetaAccess] = useState<Row | null>(null);
  const [metaAccessCheckNonce, setMetaAccessCheckNonce] = useState(0);
  const [mode, setMode] = useState<"NOVA" | "TURBINAR" | "MAKE_ONLY">("NOVA");
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
  const [recoverRequestId, setRecoverRequestId] = useState<string | null>(null);
  const [historyDiscardId, setHistoryDiscardId] = useState<string | null>(null);
  const [historyDiscardBusy, setHistoryDiscardBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [activationConfirmId, setActivationConfirmId] = useState<string | null>(null);
  const [activationConfirmWord, setActivationConfirmWord] = useState("");
  const [activationBusyId, setActivationBusyId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Row>({});
  const [confirmWord, setConfirmWord] = useState("");
  const [executing, setExecuting] = useState(false);
  const [creationStatus, setCreationStatus] = useState<"PAUSED" | "ACTIVE">("PAUSED");
  const [makeDelivery, setMakeDelivery] = useState(false);
  const [makeRecipient, setMakeRecipient] = useState("");
  const [makeProduct, setMakeProduct] = useState("");
  const [makeDeliveryMode, setMakeDeliveryMode] = useState<"SINGLE" | "ROUND_ROBIN">("SINGLE");
  const [makeRecipients, setMakeRecipients] = useState<Array<{name: string;phone: string}>>([
    { name: "", phone: "" }, { name: "", phone: "" },
  ]);
  const [makeBusyId, setMakeBusyId] = useState<string | null>(null);
  const [executionStep, setExecutionStep] = useState("");
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

  useEffect(() => {
    if (!session?.access_token || !clientName) {
      setMetaAccess(null);
      return;
    }
    let cancelled = false;
    const requestedClient = clientName;
    setMetaAccess({ client_name: requestedClient, checking: true });
    api({ action: "CHECK_META_ACCESS", client_name: requestedClient }).then(({ ok, body }) => {
      if (cancelled) return;
      setMetaAccess({ client_name: requestedClient, checking: false,
        account_access: ok && body?.account_access === true,
        page_access: ok && body?.page_access === true,
        ready: ok && body?.ready === true,
        account_id: ok ? (body?.account_id || null) : null,
        account_error: ok ? (body?.account_error || null) : null,
        page_error: ok ? (body?.page_error || null) : null,
        account_status_label: ok ? (body?.account_status_label || null) : null,
        account_conflict: ok ? (body?.account_conflict || null) : null,
        diagnostics: Array.isArray(body?.diagnostics) ? body.diagnostics : [],
        error: !ok ? friendlyError(body, "Não foi possível verificar o acesso Meta.") : null,
      });
    }).catch(() => {
      if (!cancelled) setMetaAccess({ client_name: requestedClient, checking: false,
        error: "Falha de conexão ao verificar as permissões da Meta." });
    });
    return () => { cancelled = true; };
  }, [api, clientName, session?.access_token, metaAccessCheckNonce]);



  const selectedClient = useMemo(
    () => (boot?.clients || []).find((c: Row) => c.display_name === clientName) || null,
    [boot, clientName],
  );

  const changeGuided=(key:keyof Guided,value:string)=>{
    setGuided((old)=>({...old,[key]:value,...(key==="objective"?{destination:value==="OUTCOME_TRAFFIC"?"SITE":"LEAD_FORM"}:{})}));
    setDraft(null);setDraftError("");setRecoverRequestId(null);setOverrides({});setConfirmWord("");setResult(null);
  };
  const resetFlow = () => {
    setDraft(null); setDraftError(""); setRecoverRequestId(null); setOverrides({}); setConfirmWord(""); setResult(null);
    setCreationStatus("PAUSED");
    setMakeDelivery(false);
    setMakeRecipient("");
    setMakeProduct("");
    setMakeDeliveryMode("SINGLE");
    setMakeRecipients([{ name: "", phone: "" }, { name: "", phone: "" }]);
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
    setDrafting(true); setDraftError(""); setRecoverRequestId(null); setDraft(null); setResult(null); setOverrides({}); setConfirmWord("");
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
    const budget = Number(overrides.daily_budget_brl || draft.plan?.adset?.daily_budget_brl);
    const formId = String(overrides.lead_form_id || draft.plan?.adset?.destination?.lead_form_id || "").trim();
    const destination = draft.plan?.adset?.destination?.type;
    const creativeCount = Array.isArray(draft.creatives) ? draft.creatives.length : creatives.length;
    if (!Number.isFinite(budget) || budget < 1 || budget > 100000) {
      setDraftError("Defina um orçamento diário válido antes de criar na Meta."); return;
    }
    if (destination === "LEAD_FORM" && !/^\d{5,30}$/.test(formId)) {
      setDraftError("Selecione um formulário instantâneo válido antes de criar."); return;
    }
    const recipient = makeRecipient.replace(/\D/g, "");
    const makeProductName = (makeProduct || (method === "GUIDED" ? guided.product : "")).trim();
    const roletaRecipients = makeRecipients.map((r) => ({
      name: r.name.trim(), phone: r.phone.replace(/\D/g, ""),
    }));
    if (makeDelivery) {
      if (makeProductName.length < 3) {
        setDraftError("Informe o nome do produto que aparecerá no título NOVO LEAD."); return;
      }
      if (destination !== "LEAD_FORM") {
        setDraftError("O envio via Make exige formulário instantâneo do Facebook."); return;
      }
      if (!boot?.make_delivery_available) {
        setDraftError("Entrega via Make indisponível: é preciso configurar a credencial do Make e a conexão Facebook Lead Ads."); return;
      }
      if (makeDeliveryMode === "SINGLE" && !/^55[1-9][0-9]{9,10}$/.test(recipient)) {
        setDraftError("Informe o número do destinatário com 55 + DDD + telefone, somente dígitos."); return;
      }
      if (makeDeliveryMode === "ROUND_ROBIN" && (
          roletaRecipients.length < 2 || roletaRecipients.length > 25 ||
          roletaRecipients.some((r) => r.name.length < 2 || !/^55[1-9][0-9]{9,10}$/.test(r.phone)) ||
          new Set(roletaRecipients.map((r) => r.phone)).size !== roletaRecipients.length
      )) {
        setDraftError("Informe pelo menos dois corretores, com nomes e números de WhatsApp válidos e diferentes."); return;
      }
      if (creationStatus === "ACTIVE") {
        setDraftError("Campanhas com entrega via Make devem ser criadas pausadas; ative somente depois da automação estar pronta."); return;
      }
    }
    if (draft.mode !== "BOOST" && creativeCount < 1) {
      setDraftError("Anexe ao menos um criativo e gere novamente o plano antes de criar."); return;
    }
    setExecuting(true); setDraftError(""); setExecutionStep("Criando campanha, conjunto e anúncios na Meta...");
    try {
      const { ok, body, status } = await api({ action: "EXECUTE", request_id: draft.request_id, confirmation: "CRIAR",
        overrides: { ...overrides, make_delivery: makeDelivery ? {
          enabled: true, mode: makeDeliveryMode,
          product: makeProductName,
          recipient_phone: makeDeliveryMode === "SINGLE" ? recipient : roletaRecipients[0].phone,
          recipients: makeDeliveryMode === "ROUND_ROBIN" ? roletaRecipients : [],
        } : null } });
      if (!ok) {
        // Requests FAILED cannot be submitted as DRAFTED again. RESUME_DRAFT
        // verifies the author, completed rollback, and absence of Meta objects.
        const recoverableResponse = (body?.error === "request_not_draft" && body?.status === "FAILED") ||
          (body?.error === "execution_failed" && Number(body?.meta_code) === 100 &&
            body?.rollback_incomplete === false);
        setRecoverRequestId(recoverableResponse ? String(draft.request_id) : null);
        const fallback = `Falha ao criar (HTTP ${status}). Nenhuma ativação foi confirmada.`;
        setDraftError(friendlyError(body, fallback) +
          (body?.detail ? ` Detalhe Meta: ${String(body.detail).slice(0, 230)}.` : "") +
          (body?.stage ? ` Etapa: ${body.stage}.` : "") +
          (body?.meta_code ? ` Código: ${body.meta_code}.` : "") +
          (body?.rollback_incomplete ? " Atenção: a reversão ficou incompleta. Confira o histórico antes de nova tentativa." : ""));
        await loadBoot();
        return;
      }
      setRecoverRequestId(null);
      if (makeDelivery) {
        setExecutionStep("Campanha pausada. Configurando Facebook Lead Ads e Z-API no Make...");
        const automation = await api({ action: "CONFIGURE_MAKE_DELIVERY", request_id: draft.request_id });
        if (automation.ok && automation.body?.status === "READY") {
          setResult({ ...body, campaign_status: "PAUSED", make_delivery: automation.body });
        } else {
          setResult({ ...body, campaign_status: "PAUSED",
            make_delivery: { status: "ERROR", error: friendlyError(automation.body, "Erro ao criar a automação no Make.") } });
          setDraftError("Campanha criada PAUSADA, mas a entrega de leads ainda não está configurada. Não ative a campanha: consulte o erro e tente novamente no histórico.");
        }
      } else if (creationStatus === "ACTIVE") {
        setExecutionStep("Campanha criada. Ativando e verificando campanha, conjunto e anúncios...");
        try {
          const activation = await api({ action: "ACTIVATE_CREATED", request_id: draft.request_id, confirmation: "ATIVAR" });
          if (!activation.ok || activation.body?.status !== "VERIFIED") {
            setResult({ ...body, desired_status: "ACTIVE", campaign_status: "PAUSED", activation_error: friendlyError(activation.body, "Não foi possível confirmar a ativação."), activation_audit_id: activation.body?.audit_id || null });
            setDraftError("A campanha foi criada na Meta, mas a ativação não foi confirmada. Confira o status real na Meta antes de tentar novamente.");
          } else {
            setResult({ ...body, desired_status: "ACTIVE", campaign_status: "ACTIVE", activation_audit_id: activation.body?.audit_id || null });
          }
        } catch (activationError) {
          setResult({ ...body, desired_status: "ACTIVE", campaign_status: "UNKNOWN", activation_error: String((activationError as Error)?.message || activationError) });
          setDraftError("Campanha criada, mas houve falha de rede na confirmação da ativação. Verifique o status na Meta antes de repetir.");
        }
      } else {
        setResult({ ...body, desired_status: "PAUSED", campaign_status: "PAUSED" });
      }
      setDraft(null); setRecoverRequestId(null); setPrompt(""); setFiles([]); setCreatives([]); setConfirmWord(""); setCreationStatus("PAUSED");
      setMakeDelivery(false); setMakeRecipient(""); setMakeProduct("");
      setMakeDeliveryMode("SINGLE"); setMakeRecipients([{ name: "", phone: "" }, { name: "", phone: "" }]);
      if (fileRef.current) fileRef.current.value = "";
      await loadBoot();
    } catch (error) {
      setDraftError("A conexão foi interrompida durante a criação: " + String((error as Error)?.message || error).slice(0, 160) +
        ". Consulte Últimos pedidos e a Meta antes de tentar novamente para evitar duplicações.");
      await loadBoot();
    } finally {
      setExecuting(false); setExecutionStep("");
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


  const resumeFromHistory = async (entry: Row) => {
    if (!session?.access_token || resumingId || executing || drafting) return;
    setResumingId(String(entry.id)); setHistoryError(""); setHistoryNotice("");
    try {
      const { ok, body } = await api({ action: "RESUME_DRAFT", request_id: entry.id });
      if (!ok) {
        setHistoryError(friendlyError(body, "Não foi possível retomar o rascunho."));
        return;
      }
      setMode(body.mode === "BOOST" ? "TURBINAR" : "NOVA");
      setClientName(body.client?.display_name || entry.client_name || "");
      setMethod("PROMPT");
      setPrompt(body.prompt || "");
      setFiles([]);
      setCreatives(body.creatives || []);
      if (fileRef.current) fileRef.current.value = "";
      setDraft(body); setRecoverRequestId(null);
      setOverrides(body.existing_form_id ? { lead_form_id: String(body.existing_form_id) } : {});
      setConfirmWord(""); setResult(null); setDraftError("");
      setHistoryNotice(body.resumed_failed_token_attempt
        ? (body.plan?.adset?.destination?.type === "LEAD_FORM"
          ? "Tentativa recuperada: cidades revalidadas, formulário e criativos preservados. Revise o público antes de criar."
          : "Tentativa recuperada: cidades revalidadas e criativos preservados. Revise o público antes de criar.")
        : "Rascunho retomado para revisão. Confira o plano e clique em Criar campanha; ela é criada pausada por padrão.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      await loadBoot();
    } catch (err) {
      setHistoryError(`Falha de conexão: ${String((err as Error)?.message || err).slice(0,160)}`);
    } finally {
      setResumingId(null);
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

  const configureMakeFromHistory = async (entry: Row) => {
    if (makeBusyId) return;
    setMakeBusyId(String(entry.id)); setHistoryError(""); setHistoryNotice("");
    try {
      const { ok, body } = await api({ action: "CONFIGURE_MAKE_DELIVERY", request_id: entry.id });
      if (!ok) setHistoryError(friendlyError(body, "Não foi possível configurar o Make. A campanha permanece pausada."));
      else setHistoryNotice("Automação ativa e verificada no Make. Cenário #" + String(body.scenario_id || ""));
      await loadBoot();
    } finally { setMakeBusyId(null); }
  };

  const activateFromHistory = async (entry: Row) => {
    if (!entry?.id || activationBusyId || activationConfirmId !== entry.id ||
        activationConfirmWord.trim().toUpperCase() !== "ATIVAR") return;
    setActivationBusyId(String(entry.id));
    setHistoryError(""); setHistoryNotice("");
    try {
      const { ok, body } = await api({
        action: "ACTIVATE_CREATED", request_id: entry.id, confirmation: "ATIVAR",
      });
      if (!ok) {
        setHistoryError(friendlyError(body, "Falha ao ativar na Meta.") +
          (body?.audit_id ? ` Auditoria: ${body.audit_id}.` : "") +
          (body?.rollback_ok === false ? " ATENCAO: restauracao incompleta; verifique a Meta antes de tentar novamente." : ""));
        return;
      }
      setHistoryNotice(`Campanha ${body.campaign_id}, conjunto ${body.adset_id} e ${body.ad_ids?.length || 0} anuncio(s) configurados como ATIVOS e verificados na Meta. A veiculacao depende de revisao, saldo e politicas da Meta.`);
      setActivationConfirmId(null); setActivationConfirmWord("");
      await loadBoot();
    } catch (error) {
      setHistoryError(`Falha de conexao ao ativar: ${String((error as Error)?.message || error).slice(0, 160)}. Confira o status na Meta antes de repetir.`);
    } finally {
      setActivationBusyId(null);
    }
  };

  const previousDraftStatus = (boot?.history || []).find((item: Row) => item.id === draft?.request_id);
  const eligibleForRecovery = previousDraftStatus?.status === "FAILED" &&
    previousDraftStatus.safe_retry_eligible === true &&
    !previousDraftStatus.created_campaign_id &&
    !previousDraftStatus.created_adset_id && !previousDraftStatus.created_ad_id;
  const needsDraftRecovery = Boolean(draft?.request_id &&
    (recoverRequestId === String(draft.request_id) || eligibleForRecovery));
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
        .cb-history-actions button.cb-activate-button{background:rgba(34,197,94,.13);border-color:rgba(34,197,94,.5);color:#95f1b2}
        .cb-history-actions button.cb-activate-button:hover:not(:disabled){background:rgba(34,197,94,.22);border-color:#4ade80;color:#fff}
        .cb-activation-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:8px;border:1px solid rgba(34,197,94,.3);border-radius:9px;padding:10px;width:100%}
        .cb-activation-confirm .cb-hint{flex-basis:100%;line-height:1.5}
        .cb-activation-confirm input{width:165px;max-width:100%;background:#111d2a;color:#fff;border:1px solid #456076;border-radius:8px;padding:8px 10px;font:inherit}
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
          <p>Crie campanhas pela IA ou configuração guiada, turbine publicações e crie somente o Make para uma campanha e formulário existentes.</p>
        </header>

        {bootError && <div className="cb-error">{bootError}</div>}
        {boot && mode !== "MAKE_ONLY" && boot.planner_configured === false && (
          <div className="cb-error">
            A IA do Campaign Builder ainda não está configurada: falta a secret OPENAI_API_KEY no Supabase.
            Nenhuma imagem será enviada enquanto o planejador estiver indisponível.
            Depois de cadastrar a chave, atualize a página.
          </div>
        )}
        {result && (
          <div className="cb-success" role="status">
            <b>{result.campaign_status === "ACTIVE" ? "Campanha criada e ativada na Meta" :
              result.campaign_status === "PAUSED" ? "Campanha criada e pausada na Meta" :
              "Campanha criada; confirme o status na Meta"}: {result.campaign_name}</b>
            <div style={{ marginTop: 8 }}>IDs reais — campanha {result.campaign_id} · conjunto {result.adset_id} · anúncios {(result.ad_ids || [result.ad_id]).join(", ")}.</div>
            {result.make_delivery?.status === "READY" && (
              <div style={{ marginTop: 8, color: "#8ee1aa" }}>
                Make + Z-API configurados · cenário #{result.make_delivery.scenario_id} · destinatário {result.make_delivery.recipient || "confirmado"}.
              </div>
            )}
            {result.make_delivery?.status === "ERROR" && (
              <div style={{ marginTop: 8, color: "#ffbd9e" }}>
                Automação NÃO configurada: {result.make_delivery.error}. A campanha deve permanecer PAUSADA até corrigir.
              </div>
            )}
            {result.placement?.pairs ? <div style={{ marginTop: 6 }}>{result.placement.pairs} {result.placement.pairs === 1 ? "anúncio criado" : "anúncios criados"} com versão feed e versão story no mesmo anúncio.</div> : null}
            {(result.placement?.fallbacks || []).length ? <div style={{ marginTop: 6, color: "#ffcf7a" }}>Atenção: {(result.placement.fallbacks || []).length} par(es) feed+story foram criados como anúncios separados ({(result.placement.fallbacks || []).map((f: Row) => f.reason === "instagram_missing" ? "Instagram não vinculado à Página" : "Meta recusou a personalização").join("; ")}).</div> : null}
            {result.activation_error ? <div style={{ marginTop: 8, color: "#ffbd9e" }}>
              Falha na ativação: {result.activation_error}. Não repita a criação; use o histórico e confira o status na Meta.
            </div> : <div style={{ marginTop: 8 }}>
              {result.campaign_status === "ACTIVE" ? "Status ACTIVE verificado na Meta. A entrega depende da análise dos anúncios, do saldo e das políticas da plataforma." :
                "Nenhum gasto novo será iniciado por esta criação. Você pode ativar depois pelo histórico."}
            </div>}
          </div>
        )}

        <section className="cb-card">
          <div className="cb-mode">
            <button className={mode === "NOVA" ? "active" : ""} onClick={() => { setMode("NOVA"); resetFlow(); }}>Campanha nova</button>
            <button className={mode === "TURBINAR" ? "active" : ""} onClick={() => { setMode("TURBINAR"); resetFlow(); }}>Turbinar publicação</button>
            <button className={mode === "MAKE_ONLY" ? "active" : ""} onClick={() => { setMode("MAKE_ONLY"); resetFlow(); }}>Criar somente Make</button>
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
                <>
                  <div className="cb-asset-flags">
                    <span className={`cb-pill ${!selectedClient.has_ad_account ? "bad" :
                      metaAccess?.client_name === clientName && !metaAccess.checking ?
                        (metaAccess.account_access ? "ok" : "bad") : "muted"}`}>
                      {selectedClient.account_conflict ? "Conta de anúncio divergente: confirme em Ativos Meta" :
                        !selectedClient.has_ad_account ? "Sem conta de anúncio" :
                        metaAccess?.client_name === clientName && !metaAccess.checking && !metaAccess.account_access &&
                          metaAccess.account_status_label && metaAccess.account_status_label !== "ACTIVE" ?
                          `Conta: status ${metaAccess.account_status_label} na Meta` :
                        metaAccess?.client_name !== clientName || metaAccess.checking ? "Conta: verificando acesso" :
                        metaAccess.account_access ? "Conta de anúncio: acesso confirmado" : "Conta: acesso Meta negado"}
                    </span>
                    <span className={`cb-pill ${!selectedClient.has_page ? "bad" :
                      metaAccess?.client_name === clientName && !metaAccess.checking ?
                        (metaAccess.page_access ? "ok" : "bad") : "muted"}`}>
                      {!selectedClient.has_page ? "Página não cadastrada" :
                        metaAccess?.client_name !== clientName || metaAccess.checking ? "Página: verificando acesso" :
                        metaAccess.page_access ? "Página: acesso confirmado" : "Página: acesso Meta negado"}
                    </span>
                  </div>
                  {metaAccess?.client_name === clientName && !metaAccess.checking &&
                    selectedClient.has_page && selectedClient.has_ad_account &&
                    (!metaAccess.page_access || !metaAccess.account_access) && (
                    <div className="cb-error" role="alert" style={{ marginTop: 8 }}>
                      {metaAccess.page_access && !metaAccess.account_access ? (
                        <>
                          <b>Conta de anúncios sem autorização de criação.</b> A Página deste cliente já está autorizada.
                          {metaAccess.account_error ? <> Motivo informado pela Meta: <b>{String(metaAccess.account_error).slice(0, 200)}</b>.</> : null}
                          {" "}No portfólio do cliente, abra {" "}
                          <a href="https://business.facebook.com/settings" target="_blank" rel="noopener noreferrer"
                            style={{ color: "#ffcfaf", textDecoration: "underline" }}>Configurações do negócio</a>,
                          entre em Contas de anúncios, selecione a conta <b>{metaAccess.account_id || "do cliente"}</b> e verifique o compartilhamento
                          com a empresa parceira Leonardo Imobi, com permissão para gerenciar campanhas. No portfólio da agência, confira em
                          Usuários do sistema se o usuário do Builder possui essa conta atribuída para administrar anúncios.
                        </>
                      ) : (
                        <>
                          A Meta não autorizou todos os ativos necessários à criação. Confira a Página e a conta em{" "}
                          <a href="https://business.facebook.com/settings" target="_blank" rel="noopener noreferrer"
                            style={{ color: "#ffcfaf", textDecoration: "underline" }}>Configurações do negócio</a>
                          {" "}e conceda à empresa parceira as permissões de anúncios e, para formulários, leads.
                          {metaAccess.account_error ? <div style={{ marginTop: 6 }}>Conta de anúncios: {String(metaAccess.account_error).slice(0, 200)}</div> : null}
                          {metaAccess.page_error ? <div style={{ marginTop: 6 }}>Página: {String(metaAccess.page_error).slice(0, 200)}</div> : null}
                        </>
                      )}
                      <div style={{ marginTop: 10 }}>
                        <button type="button" disabled={Boolean(metaAccess.checking)}
                          onClick={() => setMetaAccessCheckNonce((value) => value + 1)}>
                          {metaAccess.checking ? "Verificando…" : "Verificar acesso novamente"}
                        </button>
                      </div>
                      {Array.isArray(metaAccess.diagnostics) && metaAccess.diagnostics.length > 0 && (
                        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
                          <b>Diagnóstico das credenciais Meta:</b>
                          {metaAccess.diagnostics.map((item: Row, index: number) => (
                            <div key={index}>
                              {item.source}: {item.actor?.name || "Usuário não identificado"}
                              {item.actor?.id ? ` (#${item.actor.id})` : ""} · Página: {item.page_access ? "autorizada" : `negada, código ${item.page_code ?? "não informado"}`}
                              {!item.page_access && item.page_error ? <> · {String(item.page_error).slice(0, 175)}</> : null}
                              {" "}· Conta de anúncios: {item.account_access ? "autorizada" : `negada${item.account_code ? `, código ${item.account_code}` : ""}`}
                              {!item.account_access && item.account_error ? <> · {String(item.account_error).slice(0, 180)}</> : null}
                              {" "}· Escopos: {(item.permissions || []).filter((v: string) =>
                                /^(pages_|leads_retrieval|ads_management|business_management)/.test(v)).join(", ") || "nenhum identificado"}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {metaAccess?.client_name === clientName && !metaAccess.checking && metaAccess.error &&
                    <div className="cb-error" role="alert">{metaAccess.error}</div>}
                </>
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
            ) : mode === "TURBINAR" ? (
              <div className="cb-field">
                <label>Publicação selecionada</label>
                <span className="cb-hint">{selectedPost ? `${selectedPost.source === "INSTAGRAM" ? "Instagram" : "Facebook"} · ${(selectedPost.caption || "(sem legenda)").slice(0, 70)}` : "Escolha uma publicação abaixo."}</span>
              </div>
            ) : null}
            {(mode==="TURBINAR"||(mode==="NOVA"&&method==="PROMPT"))&&<div className="cb-field full">
              <label>Pedido para a IA</label>
              <textarea value={prompt} onChange={(ev)=>{setPrompt(ev.target.value);resetFlow();}}
                placeholder='Ex.: campanha de leads no litoral norte, R$ 20/dia, formulário instantâneo, com meus criativos.'/>
            </div>}
          </div>

          {mode==="MAKE_ONLY"&&<MakeOnlyPanel key={clientName} clientName={clientName} available={Boolean(boot?.make_delivery_available)} api={api} />}
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
          {mode !== "MAKE_ONLY" && <div className="cb-actions" style={{ marginTop: 12 }}>
            <button className="cb-btn primary" disabled={!clientName || (mode==="TURBINAR"||method==="PROMPT" ? prompt.trim().length<15 : false) || drafting || boot?.planner_configured===false || (mode==="TURBINAR" && !selectedPost)} onClick={generate}>
              {drafting ? (uploadProgress || "Gerando plano…") : draft ? "Gerar de novo" : "Gerar plano"}
            </button>
            {draft && <button className="cb-btn ghost" onClick={discard}>Descartar rascunho</button>}
          </div>}
          {draftError && <div className="cb-error" role="alert" style={{ marginTop: 12 }}>{draftError}</div>}
          {needsDraftRecovery && draft?.request_id && (
            <div className="cb-field" style={{ marginTop: 12 }}>
              <p className="cb-hint">Este pedido já falhou e precisa ser retomado com verificação de rollback. Os criativos do pedido original serão preservados.</p>
              <button type="button" className="cb-btn primary" disabled={Boolean(resumingId) || executing || drafting}
                onClick={() => void resumeFromHistory({ id: draft.request_id, client_name: clientName })}>
                {resumingId ? "Verificando e recuperando…" : "Retomar tentativa com criativos salvos"}
              </button>
            </div>
          )}

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
                  <span>Localização</span><b>{(plan.geo_resolved || []).length ? (plan.geo_resolved || []).map((g: Row) => g.type === "city"
                           ? `${g.name} (${g.region || "UF não informada"})`
                           : `${g.name} (região)`).join(", ") : "Brasil (ampla)"}{plan.adset?.geo?.radius_km ? ` · raio ${plan.adset.geo.radius_km} km` : ""}</b>
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
                      pageId={String(draft.assets?.page_id || "")}
                      api={api} onSelect={(id) => setOv("lead_form_id", id)} />
                    <div className="cb-field full" style={{ marginTop: 18, padding: 14, border: "1px solid #254660", borderRadius: 12 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input type="checkbox" checked={makeDelivery}
                          disabled={!boot?.make_delivery_available || executing}
                          onChange={(e) => {
                            setMakeDelivery(e.target.checked);
                            if (e.target.checked) setCreationStatus("PAUSED");
                          }} />
                        Entregar novos leads via Make + Z-API (WhatsApp)
                      </label>
                      <span className="cb-hint">
                        Usa a página e o formulário deste cliente. Todas as perguntas são recuperadas do formulário real da Meta e mapeadas automaticamente.
                        A instância administrativa é o remetente; o destinatário é informado abaixo.
                      </span>
                      {!boot?.make_delivery_available && (
                        <span className="cb-hint" style={{ color: "#ffcf7a" }}>
                          Configuração pendente: falta integrar a API do Make e a conexão Facebook Lead Ads na Edge Function.
                          Não será possível selecionar essa entrega até a integração estar pronta.
                        </span>
                      )}
                      {makeDelivery && (
                        <div className="cb-field" style={{ marginTop: 10, display: "grid", gap: 10 }}>
                          <label>Produto no cabeçalho NOVO LEAD - [produto] *</label>
                          <input value={makeProduct} maxLength={110}
                            onChange={(e) => setMakeProduct(e.target.value)}
                            placeholder={method === "GUIDED" && guided.product ? guided.product : "Nome do imóvel / produto"} />
                          <label>Modo de entrega</label>
                          <div className="cb-methods" role="group" aria-label="Distribuição dos leads">
                            <button type="button" className={makeDeliveryMode === "SINGLE" ? "chosen" : ""}
                              onClick={() => setMakeDeliveryMode("SINGLE")}>WhatsApp único</button>
                            <button type="button" className={makeDeliveryMode === "ROUND_ROBIN" ? "chosen" : ""}
                              onClick={() => setMakeDeliveryMode("ROUND_ROBIN")}>Roleta de corretores (2 ou mais)</button>
                          </div>
                          {makeDeliveryMode === "SINGLE" ? (
                            <>
                              <label>WhatsApp que receberá os leads * (55 + DDD + número)</label>
                              <input type="tel" inputMode="numeric" required maxLength={22}
                                autoComplete="off" value={makeRecipient} onChange={(e) => setMakeRecipient(e.target.value)}
                                placeholder="5511999999999" />
                            </>
                          ) : (
                            <>
                              <span className="cb-hint">Cada novo lead será encaminhado a um corretor por vez, na ordem abaixo. A roleta será sequencial e salvará a posição no Data Store exclusivo da campanha.</span>
                              {makeRecipients.map((r,idx) => (
                                <div key={idx} className="cb-grid" style={{ alignItems: "end" }}>
                                  <div className="cb-field">
                                    <label>Corretor {idx+1} — nome *</label>
                                    <input value={r.name} maxLength={80}
                                      onChange={(e) => setMakeRecipients(old => old.map((v,i) => i === idx ? {...v,name:e.target.value} : v))}
                                      placeholder="Nome do corretor" />
                                  </div>
                                  <div className="cb-field">
                                    <label>WhatsApp (55 + DDD + número) *</label>
                                    <input type="tel" inputMode="numeric" maxLength={22}
                                      value={r.phone}
                                      onChange={(e) => setMakeRecipients(old => old.map((v,i) => i === idx ? {...v,phone:e.target.value} : v))}
                                      placeholder="5511999999999" />
                                  </div>
                                  {makeRecipients.length > 2 && (
                                    <button type="button" className="cb-btn ghost"
                                      onClick={() => setMakeRecipients(old => old.filter((_,i) => i !== idx))}>
                                      Remover corretor {idx+1}
                                    </button>
                                  )}
                                </div>
                              ))}
                              <button type="button" className="cb-btn ghost" disabled={makeRecipients.length>=25}
                                onClick={() => setMakeRecipients(old => [...old,{name:"",phone:""}])}>+ Adicionar corretor</button>
                            </>
                          )}
                          <span className="cb-hint">
                            Confirme antes de criar: cliente {clientName || "—"} · página {String(draft.assets?.page_id || "—")} ·
                            formulário {String(ov("lead_form_id", plan.adset?.destination?.lead_form_id || "") || "não selecionado")} ·
                            {makeDeliveryMode === "SINGLE" ? " destinatário " + (makeRecipient || "não informado")
                              : " roleta para " + makeRecipients.length + " corretores"}.
                            Campanha ficará pausada até a configuração do Make ser verificada.
                          </span>
                        </div>
                      )}
                    </div>
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
                      {Array.isArray(draft.ad_units) && draft.ad_units.length > 0 ? <>
                        <span>Anúncios</span>
                        <b>
                          {draft.ad_units.length} {draft.ad_units.length === 1 ? "anúncio" : "anúncios"}
                          {draft.ad_units.some((u: Row) => u.kind === "FEED_STORY") ? " (feed e story juntos no mesmo anúncio)" : ""}
                          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontWeight: 400 }}>
                            {draft.ad_units.map((u: Row, i: number) => (
                              <li key={i}>
                                {u.kind === "FEED_STORY"
                                  ? `${i + 1}: feed ${u.files?.[0] || ""} + story ${u.files?.[1] || ""}${u.via === "AI" ? " (pareado pela IA, confira)" : " (pareado pelo nome)"}`
                                  : `${i + 1}: ${u.files?.[0] || ""} (${u.orientation === "STORY" ? "story" : u.orientation === "FEED" ? "feed" : "formato não identificado"}, todos os posicionamentos)`}
                              </li>
                            ))}
                          </ul>
                          {draft.ad_units.some((u: Row) => u.kind === "SINGLE" && (u.orientation === "FEED" || u.orientation === "STORY")) ? <div style={{ marginTop: 6, fontWeight: 400, color: "#ffcf7a" }}>Feed e story que deveriam ir juntos? Use o mesmo nome nos dois arquivos, mudando só a palavra FEED/STORY, e gere o plano de novo.</div> : null}
                        </b>
                      </> : null}
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
                <h3>Criar campanha na Meta</h3>
                <p className="cb-hint">Escolha como a campanha deve ficar após a criação. O clique em <b>Criar campanha</b> executa todas as etapas; não é necessário digitar CRIAR nem publicar novamente.</p>
                <div className="cb-methods" role="group" aria-label="Status inicial da campanha">
                  <button type="button" aria-pressed={creationStatus === "PAUSED"} disabled={executing}
                    className={creationStatus === "PAUSED" ? "chosen" : ""}
                    onClick={() => setCreationStatus("PAUSED")}>
                    Criar pausada (padrão)
                    <small>Campanha, conjunto e anúncios ficam pausados. Sem novos gastos.</small>
                  </button>
                  <button type="button" aria-pressed={creationStatus === "ACTIVE"} disabled={executing || makeDelivery}
                    className={creationStatus === "ACTIVE" ? "chosen" : ""}
                    onClick={() => setCreationStatus("ACTIVE")}>
                    Criar ativa
                    <small>Após criar, ativa e verifica campanha, conjunto e anúncios na Meta. Pode iniciar gastos.</small>
                  </button>
                </div>
                <p className="cb-hint" role="status">
                  Conta: {clientName} · orçamento do conjunto: <b>{money(ov("daily_budget_brl", plan.adset?.daily_budget_brl))}/dia</b> ·
                  destino: <b>{destinationLabel[plan.adset?.destination?.type] || plan.adset?.destination?.type}</b>.
                  {creationStatus === "ACTIVE" ? " Ao confirmar, você autoriza o início da veiculação e os gastos previstos." : " A campanha será criada e permanecerá desativada."}
                </p>
                <div className="cb-confirm">
                  <button type="button" className="cb-btn primary" disabled={executing || needsDraftRecovery} onClick={() => void execute()}>
                    {needsDraftRecovery ? "Retome a tentativa antes de criar" : executing ? (executionStep || "Processando na Meta…") : creationStatus === "ACTIVE" ? "Criar campanha ativa" : "Criar campanha pausada"}
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
              const ownedByMe = Boolean(session?.user?.id) && h.actor_user_id === session?.user?.id;
              const recoverableFailure = h.status === "FAILED" &&
                !h.created_campaign_id && !h.created_adset_id && !h.created_ad_id &&
                (h.safe_retry_eligible === true ||
                  /^token:\s*(meta_account_access_missing|meta_write_permission_missing|meta_token_missing)$/.test(String(h.error || "").trim()));
              const mayResume = ownedByMe && (h.status === "DRAFTED" || recoverableFailure);
              const mayDiscard = h.status === "DRAFTED" &&
                (boot?.profile?.is_adler || boot?.profile?.role === "MGMT" || ownedByMe);
              const confirming = historyDiscardId === h.id;
              const activationConfirming = activationConfirmId === h.id;
              const mayActivate = h.status === "CREATED" &&
                (!h.make_delivery?.enabled || h.make_delivery.status === "READY") &&
                Boolean(h.created_campaign_id && h.created_adset_id && h.created_ad_id) &&
                (boot?.profile?.is_adler || boot?.profile?.role === "MGMT" || ownedByMe);
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
                    {h.activation_verified_at ? <> · última ativação verificada em {dateTime(h.activation_verified_at)}</> : null}
                    {h.make_delivery?.enabled ? <> · Make: {h.make_delivery.status} · destino {h.make_delivery.recipient}</> : null}
                    {h.status === "FAILED" && h.error ? <> · {String(h.error).slice(0, 140)}</> : null}
                    {h.status === "DRAFTED" && h.expires_at && Date.parse(h.expires_at) < Date.now() ? <> · prazo expirado</> : null}
                  </small>
                  {(mayResume || mayDiscard || mayActivate ||
                    (h.status === "CREATED" && h.make_delivery?.enabled && h.make_delivery.status !== "READY")) && (
                    <div className="cb-history-actions">
                      {h.status === "CREATED" && h.make_delivery?.enabled && h.make_delivery.status !== "READY" && (
                        <button type="button" disabled={Boolean(makeBusyId)}
                          onClick={() => void configureMakeFromHistory(h)}>
                          {makeBusyId === h.id ? "Configurando Make..." : "Configurar / reparar entrega no Make"}
                        </button>
                      )}
                      {mayResume && !confirming && (
                        <button type="button" disabled={Boolean(resumingId) || historyDiscardBusy}
                          onClick={() => void resumeFromHistory(h)}>
                          {resumingId === h.id ? "Retomando…" :
                            recoverableFailure ? (h.plan?.adset?.destination?.type === "LEAD_FORM"
                              ? "Retomar com formulário e criativos salvos" : "Retomar com criativos salvos") :
                              "Retomar / Criar na Meta (pausada)"}
                        </button>
                      )}
                      {mayDiscard && (!confirming ? (
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
                      ))}
                      {mayActivate && (!activationConfirming ? (
                        <button type="button" className="cb-activate-button"
                          disabled={Boolean(activationBusyId)}
                          onClick={() => { setActivationConfirmId(String(h.id)); setActivationConfirmWord(""); setHistoryError(""); setHistoryNotice(""); }}>
                          {h.activation_verified_at ? "Ativar novamente" : "Ativar campanha na Meta"}
                        </button>
                      ) : (
                        <div className="cb-activation-confirm" role="group" aria-label="Confirmar ativação de campanha">
                          <span className="cb-hint">
                            Ativar campanha, conjunto e anúncios na Meta pode iniciar gastos de até {money(h.plan?.adset?.daily_budget_brl)} por dia, conforme o orçamento salvo. Confira a conta e o orçamento antes de prosseguir.
                          </span>
                          <input aria-label="Digite ATIVAR para confirmar" value={activationConfirmWord} placeholder="Digite ATIVAR"
                            onChange={(e) => setActivationConfirmWord(e.target.value)} />
                          <button type="button" className="cb-activate-button"
                            disabled={Boolean(activationBusyId) || activationConfirmWord.trim().toUpperCase() !== "ATIVAR"}
                            onClick={() => void activateFromHistory(h)}>
                            {activationBusyId === h.id ? "Ativando e verificando…" : "Confirmar ativação"}
                          </button>
                          <button type="button" disabled={Boolean(activationBusyId)}
                            onClick={() => { setActivationConfirmId(null); setActivationConfirmWord(""); }}>
                            Cancelar
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {boot?.profile?.is_adler && <PortfolioAuditPanel api={api} />}
      </div>
    </main>
  );
}
