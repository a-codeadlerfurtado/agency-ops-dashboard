import { supabase } from "./supabase";
import type { Activity, Opportunity, Profile, Stage, Task } from "./types";

const OPP_COLS =
  "id, tenant_id, contact_id, assigned_user_id, stage_id, status, source, source_detail," +
  " campaign_name, adset_name, ad_name, created_at, accepted_at, first_contact_at," +
  " qualified_at, closed_at, last_interaction_at, lost_reason," +
  " property_id, development_id," +
  " contact:contacts(id, full_name, phone, phone_normalized, email)," +
  " property:properties(id, code, title)," +
  " development:developments(id, name)";

export async function etapas(tenantId: string): Promise<Stage[]> {
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("id, name, kind, sort_order, pipeline_id, pipelines!inner(is_default)")
    .eq("tenant_id", tenantId)
    .eq("pipelines.is_default", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as unknown as Stage[];
}

export async function corretores(tenantId: string): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role, profile:profiles(id, full_name, phone)")
    .eq("tenant_id", tenantId)
    .eq("status", "ACTIVE")
    .order("role");
  if (error) throw error;
  return (data ?? [])
    .map((m) => m.profile as unknown as Profile)
    .filter(Boolean);
}

export interface FiltrosLead {
  busca?: string;
  etapaId?: string;
  corretorId?: string;
  origem?: string;
  status?: string;
  /** empreendimento; "__sem" filtra os leads que ainda nao tem produto */
  empreendimentoId?: string;
}

/**
 * Paginacao por cursor (spec 66): a lista nunca puxa 10 mil leads.
 * Ordena por created_at desc e usa o proprio created_at como cursor.
 */
export async function oportunidades(
  tenantId: string,
  filtros: FiltrosLead = {},
  cursor?: string,
  limite = 40
): Promise<{ itens: Opportunity[]; proximoCursor?: string }> {
  let q = supabase
    .from("opportunities")
    .select(OPP_COLS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limite + 1);

  if (cursor) q = q.lt("created_at", cursor);
  if (filtros.etapaId) q = q.eq("stage_id", filtros.etapaId);
  if (filtros.corretorId) q = q.eq("assigned_user_id", filtros.corretorId);
  if (filtros.origem) q = q.eq("source", filtros.origem);
  if (filtros.status) q = q.eq("status", filtros.status);
  if (filtros.empreendimentoId === "__sem") q = q.is("development_id", null);
  else if (filtros.empreendimentoId) q = q.eq("development_id", filtros.empreendimentoId);

  const { data, error } = await q;
  if (error) throw error;

  let itens = (data ?? []) as unknown as Opportunity[];

  // Busca por nome/telefone e local: a lista ja vem paginada e pequena, e isso
  // evita um indice de texto que custaria escrita em toda insercao de contato.
  const termo = filtros.busca?.trim().toLowerCase();
  if (termo) {
    itens = itens.filter(
      (o) =>
        o.contact?.full_name?.toLowerCase().includes(termo) ||
        o.contact?.phone?.replace(/\D/g, "").includes(termo.replace(/\D/g, "")) ||
        o.contact?.email?.toLowerCase().includes(termo)
    );
  }

  const temMais = itens.length > limite;
  if (temMais) itens = itens.slice(0, limite);

  return {
    itens,
    proximoCursor: temMais ? itens[itens.length - 1]?.created_at : undefined,
  };
}

/**
 * Kanban: uma consulta por coluna, com a contagem real de cada uma.
 *
 * Era uma consulta so, com limite de `porColuna * 7`, agrupada no cliente. O
 * desenho supunha os leads espalhados pelas sete etapas -- e uma importacao de
 * base historica desmente isso na hora: 1586 dos 1589 leads caem em
 * "Contatado", as 350 linhas do limite global param todas na mesma coluna, e o
 * resto some sem aviso.
 *
 * Pior que sumir: o cabecalho da coluna contava o array truncado, entao a tela
 * afirmava um total errado com toda a confianca. Agora o numero vem do `count`
 * do banco e nao depende de quantos cards foram carregados.
 *
 * Sete consultas pequenas em paralelo custam menos que uma que nao cabe.
 */
export interface ColunaDoQuadro {
  etapaId: string;
  itens: Opportunity[];
  /** quantos existem de fato nesta etapa, nao quantos vieram */
  total: number;
}

export async function colunaDoQuadro(
  tenantId: string,
  etapaId: string,
  corretorId?: string,
  inicio = 0,
  quantos = 50
): Promise<{ itens: Opportunity[]; total: number }> {
  let q = supabase
    .from("opportunities")
    .select(OPP_COLS, { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("status", "OPEN")
    .eq("stage_id", etapaId)
    .order("created_at", { ascending: false })
    .range(inicio, inicio + quantos - 1);
  if (corretorId) q = q.eq("assigned_user_id", corretorId);

  const { data, count, error } = await q;
  if (error) throw error;
  return { itens: (data ?? []) as unknown as Opportunity[], total: count ?? 0 };
}

export async function oportunidadesDoQuadro(
  tenantId: string,
  etapaIds: string[],
  corretorId?: string,
  porColuna = 50
): Promise<ColunaDoQuadro[]> {
  return Promise.all(
    etapaIds.map((etapaId) =>
      colunaDoQuadro(tenantId, etapaId, corretorId, 0, porColuna).then((r) => ({
        etapaId,
        ...r,
      }))
    )
  );
}

export async function oportunidade(id: string): Promise<Opportunity> {
  const { data, error } = await supabase
    .from("opportunities")
    .select(OPP_COLS)
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as unknown as Opportunity;
}

export async function atividades(oppId: string): Promise<Activity[]> {
  const { data, error } = await supabase
    .from("activities")
    .select("id, opportunity_id, type, body, from_stage_id, to_stage_id, created_by, created_at")
    .eq("opportunity_id", oppId)
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  return (data ?? []) as Activity[];
}

export async function registrarAtividade(
  tenantId: string, oppId: string, tipo: Activity["type"], texto: string, autor: string
) {
  const { error } = await supabase.from("activities").insert({
    tenant_id: tenantId,
    opportunity_id: oppId,
    type: tipo,
    body: texto,
    created_by: autor,
  });
  if (error) throw error;
}

export async function moverEtapa(oppId: string, etapaId: string, nota?: string) {
  const { error } = await supabase.rpc("move_opportunity_stage", {
    p_opportunity_id: oppId,
    p_stage_id: etapaId,
    p_note: nota ?? null,
  });
  if (error) throw error;
}

export async function criarOportunidade(args: {
  tenantId: string;
  nome: string;
  telefone?: string;
  email?: string;
  corretorId?: string | null;
  origem?: string;
  detalhe?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_opportunity", {
    p_tenant_id: args.tenantId,
    p_full_name: args.nome,
    p_phone: args.telefone || null,
    p_email: args.email || null,
    p_assigned_user_id: args.corretorId || null,
    p_source: args.origem || "MANUAL",
    p_source_detail: args.detalhe || null,
  });
  if (error) throw error;
  return data as string;
}

export async function tarefas(usuarioId: string, incluirConcluidas = false): Promise<Task[]> {
  let q = supabase
    .from("tasks")
    .select("id, opportunity_id, assigned_user_id, title, description, due_at, completed_at, status")
    .eq("assigned_user_id", usuarioId)
    .order("due_at")
    .limit(100);
  if (!incluirConcluidas) q = q.eq("status", "OPEN");
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Task[];
}

export async function criarTarefa(args: {
  tenantId: string; oppId?: string | null; usuarioId: string;
  titulo: string; vencimento: string;
}) {
  const { error } = await supabase.from("tasks").insert({
    tenant_id: args.tenantId,
    opportunity_id: args.oppId ?? null,
    assigned_user_id: args.usuarioId,
    title: args.titulo,
    due_at: args.vencimento,
    created_by: args.usuarioId,
  });
  if (error) throw error;
}

export async function concluirTarefa(id: string) {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "DONE", completed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ------------------------------------------------------------- agregados

export interface PainelAdmin {
  cards: {
    leads: number; atendidos: number; qualificados: number; visitas: number;
    propostas: number; vendas: number; vgv: number | null; sla_perdido: number | null;
  };
  funil: { ord: number; etapa: string; kind: string; total: number }[];
  origens: { origem: string; leads: number; vendas: number; qualificados: number; vgv: number }[];
  campanhas: { campanha: string; vendas: number; vgv: number }[];
}

export async function painelAdmin(tenantId: string, dias: number): Promise<PainelAdmin> {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc("dashboard_admin", {
    p_tenant_id: tenantId,
    p_desde: desde,
  });
  if (error) throw error;
  return data as PainelAdmin;
}

export interface PainelBroker {
  novos: number; sem_aceite: number; followups_hoje: number;
  followups_atrasados: number; visitas_hoje: number; em_proposta: number;
  vendas: number; vgv: number; parados_30d: number;
}

export async function painelBroker(tenantId: string): Promise<PainelBroker> {
  const { data, error } = await supabase.rpc("dashboard_broker", { p_tenant_id: tenantId });
  if (error) throw error;
  return data as PainelBroker;
}

export interface LinhaRanking {
  user_id: string; nome: string;
  leads: number; aceitos: number; sla_perdido: number; contatados: number;
  qualificados: number; visitas: number; propostas: number; vendas: number;
  vgv: number; parados: number;
  min_ate_aceite: number | null; min_ate_contato: number | null; conversao: number | null;
}

export async function ranking(tenantId: string, dias: number): Promise<LinhaRanking[]> {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc("ranking_corretores", {
    p_tenant_id: tenantId,
    p_desde: desde,
  });
  if (error) throw error;
  return (data ?? []) as LinhaRanking[];
}

export async function leadsParados(tenantId: string): Promise<{ faixa: string; total: number }[]> {
  const { data, error } = await supabase.rpc("leads_parados", { p_tenant_id: tenantId });
  if (error) throw error;
  return (data ?? []) as { faixa: string; total: number }[];
}
