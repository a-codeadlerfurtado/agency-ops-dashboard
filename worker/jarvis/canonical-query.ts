import {
  ehAtivoOperacional,
  filtrarClientesAtivosPorAntiguidade,
  interpretarFiltroAntiguidadeClientes,
  normalizarEntidade,
  type ClientePermitido,
} from "./memory.ts";
import type { MemoriaRapida } from "./state.ts";

export type ResultadoCanonico = {
  resposta: string;
  source: string;
  memory: Omit<MemoriaRapida, "updated_at">;
};

type Filtro = { key: string; test: (c: ClientePermitido) => boolean };

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function hojeIso(offset = 0): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + offset));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function brData(iso: string | null | undefined): string {
  if (!iso) return "data não cadastrada";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

function ativos(clientes: ClientePermitido[]): ClientePermitido[] {
  return clientes.filter((c) => ehAtivoOperacional(c.lifecycle));
}

function querLista(q: string): boolean {
  return /\b(quais|quem|lista|listar|liste|nomes|todos|todas|mostra|mostrar|passe|manda)\b/.test(q);
}

function topN(q: string, padrao = 5): number {
  const m = q.match(/\b(?:top\s*)?(\d{1,2})\b/);
  const x = m ? Number(m[1]) : padrao;
  return Number.isFinite(x) && x > 0 ? Math.min(x, 30) : padrao;
}

function listaNomes(rows: ClientePermitido[]): string {
  return rows.map((c) => c.display_name).filter(Boolean).join(", ");
}
function responderConjunto(
  rows: ClientePermitido[], q: string, descricao: string, source: string, filterKey: string,
): ResultadoCanonico {
  const lista = querLista(q);
  const resposta = lista
    ? (rows.length ? `${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} ${descricao}: ${listaNomes(rows)}.` : `Não há clientes ${descricao}.`)
    : `${rows.length} ${rows.length === 1 ? "cliente" : "clientes"} ${descricao}.`;
  return {
    resposta,
    source,
    memory: {
      metric: "client_filter", period: "current", topic: `filter:${filterKey}`,
      answer_kind: lista ? "list" : "count", client_set: rows.map((c) => c.client_id), filter_key: filterKey,
    },
  };
}

function valorPeriodo(c: ClientePermitido, campo: "leads" | "spend" | "cpl", ontem: boolean): number | null {
  if (campo === "leads") return n(ontem ? c.leads_yesterday : c.leads_today);
  if (campo === "spend") return n(ontem ? c.spend_yesterday : c.spend_today);
  return n(ontem ? c.cpl_yesterday : c.cpl_today);
}

function risco(c: ClientePermitido): boolean {
  const texto = normalizarEntidade(`${c.external_risk_level ?? ""} ${c.external_health_status ?? ""} ${c.internal_band ?? ""} ${c.priority ?? ""} ${c.sentimento ?? ""}`);
  return /\b(critical|critico|high|alto|risk|risco|attention|atencao|negative|negativo|insatisfeito)\b/.test(texto)
    || Number(c.open_complaints ?? 0) > 0;
}

function baseDeFollowup(clientes: ClientePermitido[], memoria: MemoriaRapida | null, q: string): ClientePermitido[] {
  const usaAnterior = /^(?:e\s+)?(?:desses|dessas|esses|essas|deles|delas)\b/.test(q) || /\b(desses|dessas|esses|essas)\b/.test(q);
  if (!usaAnterior || !memoria?.client_set?.length) return ativos(clientes);
  const ids = new Set(memoria.client_set);
  return clientes.filter((c) => ids.has(c.client_id));
}
const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function faixaMes(q: string): { inicio: string; fim: string; label: string } | null {
  const hoje = hojeIso();
  const [anoAtual, mesAtual] = hoje.split("-").map(Number);
  let ano = anoAtual, mes = mesAtual, label = "este mês";
  if (/\bmes passado\b/.test(q)) {
    mes -= 1; if (mes < 1) { mes = 12; ano -= 1; } label = "no mês passado";
  } else {
    const nome = Object.keys(MESES).find((m) => new RegExp(`\\b${m}\\b`).test(q));
    if (nome) {
      mes = MESES[nome];
      const ya = q.match(/\b(20\d{2})\b/); ano = ya ? Number(ya[1]) : anoAtual;
      if (!ya && mes > mesAtual) ano -= 1;
      label = `em ${nome}${ya ? ` de ${ano}` : ""}`;
    } else if (!/\b(este mes|nesse mes|neste mes)\b/.test(q)) return null;
  }
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const mm = String(mes).padStart(2, "0");
  return { inicio: `${ano}-${mm}-01`, fim: `${ano}-${mm}-${String(ultimo).padStart(2, "0")}`, label };
}

function dataFalavelNaPergunta(q: string): string | null {
  const hoje = hojeIso();
  if (/\bhoje\b/.test(q)) return hoje;
  if (/\bontem\b/.test(q)) return hojeIso(-1);
  const m = q.match(/\b(?:dia\s+)?(\d{1,2})\s+de\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(20\d{2}))?\b/);
  if (!m) return null;
  let ano = m[3] ? Number(m[3]) : Number(hoje.slice(0, 4));
  const mes = MESES[m[2]]; const dia = Number(m[1]);
  const candidato = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  if (!m[3] && candidato > hoje) ano -= 1;
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}
function eventoEntradaOuSaida(
  q: string, clientes: ClientePermitido[], campo: "entrada" | "saida",
): ResultadoCanonico | null {
  const ehEntrada = campo === "entrada";
  const assunto = ehEntrada ? /\b(entrou|entraram|entrada|novo cliente|novos clientes)\b/.test(q) : /\b(churn|churnou|churnaram|saiu|sairam|saida|cancelou|cancelaram)\b/.test(q);
  if (!assunto) return null;
  const rows = clientes.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c[campo] ?? "")));
  const ordem = [...rows].sort((a, b) => String(a[campo]).localeCompare(String(b[campo])));
  const ultimo = /\b(ultimo|ultima|mais recente|recentemente)\b/.test(q);
  const primeiro = /\b(primeiro|primeira|mais antigo|mais antiga)\b/.test(q);
  if (ultimo || primeiro) {
    const c = primeiro ? ordem[0] : ordem.at(-1);
    if (!c) return null;
    const verbo = ehEntrada ? "entrou" : "saiu";
    return {
      resposta: `${c.display_name} foi ${primeiro ? "o primeiro" : "o último"} cliente que ${verbo}, em ${brData(c[campo])}.`,
      source: `snapshot:${campo}_order`,
      memory: { client_id: c.client_id, client_name: c.display_name, metric: campo, period: "current", topic: campo, answer_kind: "text" },
    };
  }
  const faixa = faixaMes(q); const dia = dataFalavelNaPergunta(q);
  if (!faixa && !dia) return null;
  const encontrados = ordem.filter((c) => {
    const d = String(c[campo]);
    return dia ? d === dia : d >= faixa!.inicio && d <= faixa!.fim;
  });
  const label = dia ? `em ${brData(dia)}` : faixa!.label;
  const descricao = ehEntrada ? `que entraram ${label}` : `que deram churn ${label}`;
  return responderConjunto(encontrados, q, descricao, `snapshot:${campo}_period`, `${campo}:${dia ?? faixa!.inicio}`);
}
function ativosEmData(q: string, clientes: ClientePermitido[]): ResultadoCanonico | null {
  if (!/\b(ativos?|carteira)\b/.test(q) || !/\b(em|no dia|na data)\b/.test(q)) return null;
  const dia = dataFalavelNaPergunta(q); if (!dia || dia === hojeIso()) return null;
  const rows = clientes.filter((c) => {
    const entrada = String(c.entrada ?? ""), saida = String(c.saida ?? "");
    return /^\d{4}-\d{2}-\d{2}$/.test(entrada) && entrada <= dia && (!/^\d{4}-\d{2}-\d{2}$/.test(saida) || saida > dia);
  });
  return responderConjunto(rows, q, `ativos em ${brData(dia)}`, "snapshot:historical_active", `active_at:${dia}`);
}

function compararHojeOntem(q: string, clientes: ClientePermitido[], cliente: ClientePermitido | null): ResultadoCanonico | null {
  if (!/\b(hoje.*ontem|ontem.*hoje|compar[a-z ]{0,20}(?:hoje|ontem)|desde ontem)\b/.test(q)) return null;
  const metric = /\bcpl\b/.test(q) ? "cpl" : /\b(gasto|gastou|spend|investimento)\b/.test(q) ? "spend" : /\bleads?\b/.test(q) ? "leads" : null;
  if (!metric) return null;
  const base = cliente ? [cliente] : ativos(clientes);
  const soma = (ontem: boolean) => {
    const vals = base.map((c) => valorPeriodo(c, metric, ontem)).filter((v): v is number => v !== null);
    if (!vals.length) return null;
    if (metric === "cpl" && !cliente) {
      const spend = base.map((c) => valorPeriodo(c, "spend", ontem) ?? 0).reduce((a,b)=>a+b,0);
      const leads = base.map((c) => valorPeriodo(c, "leads", ontem) ?? 0).reduce((a,b)=>a+b,0);
      return leads > 0 ? spend / leads : null;
    }
    return vals.reduce((a,b)=>a+b,0);
  };
  const h=soma(false), o=soma(true); if(h===null||o===null)return null;
  const nome=cliente?.display_name??"A carteira"; const delta=o===0?null:((h-o)/Math.abs(o))*100;
  const fmt=(v:number)=>metric==="leads"?String(Math.round(v)):new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v);
  const direcao=h===o?"ficou igual":h>o?"subiu":"caiu";
  const pct=delta===null?"":` (${Math.abs(delta).toFixed(1).replace(".",",")}% ${delta>=0?"acima":"abaixo"})`;
  return {resposta:`${nome}: ${metric.toUpperCase()} hoje ${fmt(h)}; ontem ${fmt(o)}. ${direcao}${pct}.`,source:"snapshot:compare_today_yesterday",memory:{client_id:cliente?.client_id??null,client_name:cliente?.display_name??null,metric,period:"current",topic:"comparison",answer_kind:"metric"}};
}
function rankingMidia(q: string, clientes: ClientePermitido[]): ResultadoCanonico | null {
  const metric = /\bcpl\b/.test(q) ? "cpl" : /\b(leads?)\b/.test(q) ? "leads" : /\b(gasto|gastou|spend|investimento)\b/.test(q) ? "spend" : null;
  const ranking = /\b(top|ranking|melhores|piores|maiores|menores|mais|menos)\b/.test(q);
  if (!metric || !ranking || !/\b(clientes?|carteira)\b/.test(q)) return null;
  const ontem = /\bontem\b/.test(q); const maior = /\b(piores|maiores|mais)\b/.test(q) || (metric !== "cpl" && /\bmelhores\b/.test(q));
  const crescente = metric === "cpl" ? !/\b(piores|maiores)\b/.test(q) : !maior;
  const rows = ativos(clientes).map((c) => ({ c, v: valorPeriodo(c, metric, ontem) }))
    .filter((x): x is {c:ClientePermitido;v:number} => x.v !== null)
    .sort((a,b)=>crescente?a.v-b.v:b.v-a.v).slice(0,topN(q));
  if (!rows.length) return null;
  const fmt=(v:number)=>metric==="leads"?String(Math.round(v)):new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v);
  const nomes=rows.map((x,i)=>`${i+1}. ${x.c.display_name} — ${fmt(x.v)}`).join("; ");
  const periodo=ontem?"ontem":"hoje";
  return {
    resposta:`Ranking de ${metric.toUpperCase()} ${periodo}: ${nomes}.`, source:"snapshot:media_ranking",
    memory:{metric:`ranking_${metric}`,period:ontem?"yesterday":"today",topic:"media_ranking",answer_kind:"list",client_set:rows.map(x=>x.c.client_id),filter_key:`ranking:${metric}:${periodo}`},
  };
}

function atividadeParada(q:string, clientes:ClientePermitido[]): ResultadoCanonico|null {
  if(!/\b(sumidos?|parados?|mais parados|sem atividade|inativos?)\b/.test(q))return null;
  const rows=ativos(clientes).filter(c=>c.last_activity_at).sort((a,b)=>String(a.last_activity_at).localeCompare(String(b.last_activity_at))).slice(0,topN(q));
  if(!rows.length)return null;
  const nomes=rows.map(c=>`${c.display_name} — última atividade ${brData(String(c.last_activity_at).slice(0,10))}`).join("; ");
  return {resposta:`Os clientes com atividade mais antiga são: ${nomes}.`,source:"snapshot:activity_ranking",memory:{metric:"last_activity",period:"current",topic:"activity_ranking",answer_kind:"list",client_set:rows.map(c=>c.client_id),filter_key:"activity_oldest"}};
}
function filtrosDaPergunta(q:string, contextoAnterior:string): { filtros:Filtro[]; descricao:string[] } {
  const filtros:Filtro[]=[]; const descricao:string[]=[];
  const add=(key:string,label:string,test:(c:ClientePermitido)=>boolean)=>{filtros.push({key,test});descricao.push(label);};
  const ontem=/\bontem\b/.test(q);
  if(/\bsem\s+(?:campanha|campanhas)(?:\s+ativas?)?\b|\bnenhuma\s+campanha\b/.test(q))add("no_campaign","sem campanha ativa",c=>(n(c.active_campaigns)??0)===0);
  else if(/\bcom\s+(?:campanha|campanhas)\s+ativas?\b/.test(q))add("with_campaign","com campanha ativa",c=>(n(c.active_campaigns)??0)>0);
  if(/\b(sem|nenhum|zero)\s+leads?\b|\bnao\s+(?:teve|tem|gerou|gera)\s+leads?\b/.test(q))add(`no_leads_${ontem?"yesterday":"today"}`,`sem leads ${ontem?"ontem":"hoje"}`,c=>(valorPeriodo(c,"leads",ontem)??0)===0);
  else if(/\bcom\s+leads?\b|\bgerando\s+leads?\b/.test(q))add(`with_leads_${ontem?"yesterday":"today"}`,`com leads ${ontem?"ontem":"hoje"}`,c=>(valorPeriodo(c,"leads",ontem)??0)>0);
  if(/\b(gastando|com gasto|teve gasto|investindo)\b/.test(q))add(`spending_${ontem?"yesterday":"today"}`,`gastando ${ontem?"ontem":"hoje"}`,c=>(valorPeriodo(c,"spend",ontem)??0)>0);
  if(/\b(saldo baixo|baixo saldo|pouco saldo)\b/.test(q))add("low_balance","com saldo Meta baixo",c=>normalizarEntidade(c.balance_run_status)==="low balance");
  if(/\b(risco de churn|churn silencioso|em risco|risco alto|insatisfeit[oa]s?)\b/.test(q))add("risk","em risco",risco);
  if(/\b(reclamacao|reclamacoes|reclamando)\b/.test(q))add("complaints","com reclamação aberta",c=>Number(c.open_complaints??0)>0||Boolean(String(c.reclamacoes??"").trim()));
  if(/\b(atrasad[oa]s?|pendencias? atrasad[oa]s?|compromissos? atrasad[oa]s?)\b/.test(q))add("overdue","com pendência atrasada",c=>Number(c.overdue_commitments??0)>0);
  if(/\b(bloquead[oa]s?|travados?|blockers?)\b/.test(q))add("blocked","com bloqueio operacional",c=>Number(c.blockers??0)>0||Boolean(c.onboarding_blocked_by));
  if(/\b(alertas?|warnings?)\b/.test(q))add("alerts","com alerta aberto",c=>Number(c.alerts_count??0)>0);
  if(/\b(aprovacao pendente|aprovacoes pendentes|aguardando aprovacao)\b/.test(q))add("pending_approval","com aprovação pendente",c=>Number(c.pending_approvals??0)>0);
  if(/\bsem\s+briefing\b|\bnao\s+tem\s+briefing\b/.test(q))add("no_briefing","sem briefing vinculado",c=>!c.briefing_page_id);
  if(/\b(somente|so)\s+(?:o\s+)?bom dia\b|\bapenas\s+(?:o\s+)?bom dia\b/.test(q))add("only_good_morning","com grupo que recebeu somente bom dia hoje",c=>Number(c.wa_groups_only_good_morning??0)>0);
  if(/\bsem\s+bom dia\b|\bnao\s+(?:recebeu|teve)\s+bom dia\b/.test(q))add("no_good_morning","com grupo sem bom dia hoje",c=>Number(c.wa_groups_without_good_morning??0)>0);
  if(/\b(grupo|whatsapp|wpp)\b[\s\S]{0,30}\b(parado|sem movimento|sem mensagem)\b/.test(q))add("wa_silent","com grupo parado hoje",c=>Number(c.wa_groups_silent_today??0)>0);
  const antiguidade=interpretarFiltroAntiguidadeClientes(q,contextoAnterior);
  if(antiguidade){const dummy=filtrarClientesAtivosPorAntiguidade([],antiguidade);const limite=dummy.limite;add(`tenure_${antiguidade.comparador}_${antiguidade.meses}`,`${antiguidade.comparador} de ${antiguidade.meses} meses de casa`,c=>{const e=String(c.entrada??"");return /^\d{4}-\d{2}-\d{2}$/.test(e)&&(antiguidade.comparador==="menos"?e>limite:e<limite);});}
  return {filtros,descricao};
}
export function executarConsultaCanonica(params:{
  message:string;
  clients:ClientePermitido[];
  memoria:MemoriaRapida|null;
  explicitClient:ClientePermitido|null;
}): ResultadoCanonico|null {
  const {message,clients,memoria,explicitClient}=params;
  const q=normalizarEntidade(message); if(!q||!clients.length)return null;

  const entrada=eventoEntradaOuSaida(q,clients,"entrada"); if(entrada)return entrada;
  const saida=eventoEntradaOuSaida(q,clients,"saida"); if(saida)return saida;
  const historico=ativosEmData(q,clients); if(historico)return historico;
  const comparacao=compararHojeOntem(q,clients,explicitClient); if(comparacao)return comparacao;
  const ranking=rankingMidia(q,clients); if(ranking)return ranking;

  const contextoAnterior = memoria?.topic?.includes("active") || memoria?.topic?.includes("portfolio") || memoria?.client_set?.length
    ? "clientes ativos" : "";
  const {filtros,descricao}=filtrosDaPergunta(q,contextoAnterior);
  if(filtros.length){
    const base=baseDeFollowup(clients,memoria,q);
    const rows=base.filter(c=>filtros.every(f=>f.test(c)));
    const label=descricao.join(" e ");
    const key=filtros.map(f=>f.key).join("+");
    return responderConjunto(rows,q,label,"snapshot:canonical_filters",key);
  }
  const parada=atividadeParada(q,clients); if(parada)return parada;
  return null;
}
