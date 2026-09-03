import { supabase } from "./supabase";
import type {
  Development, Fila, HorarioFila, LeadInterest, Match, MembroFila, Property,
  PropertyStatus, PropertyType, Proposal, ProposalStatus, Sale, Visit, VisitStatus,
} from "./types";

const PROP_COLS =
  "id, development_id, code, title, type, status, city, state, neighborhood," +
  " price, condo_fee, area_m2, bedrooms, suites, bathrooms, parking_spaces," +
  " description, features, development:developments(id, name, city, neighborhood)";

/* =========================================================== imoveis === */

export interface FiltrosImovel {
  busca?: string;
  cidade?: string;
  bairro?: string;
  tipo?: PropertyType;
  status?: PropertyStatus;
  precoMax?: number;
  quartosMin?: number;
}

export async function imoveis(
  tenantId: string,
  f: FiltrosImovel = {},
  limite = 60
): Promise<Property[]> {
  let q = supabase
    .from("properties")
    .select(PROP_COLS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limite);

  if (f.status) q = q.eq("status", f.status);
  if (f.tipo) q = q.eq("type", f.tipo);
  if (f.cidade) q = q.eq("city", f.cidade);
  if (f.bairro) q = q.eq("neighborhood", f.bairro);
  if (f.precoMax) q = q.lte("price", f.precoMax);
  if (f.quartosMin) q = q.gte("bedrooms", f.quartosMin);
  if (f.busca) q = q.or(`title.ilike.%${f.busca}%,code.ilike.%${f.busca}%`);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Property[];
}

export async function empreendimentos(tenantId: string): Promise<Development[]> {
  const { data, error } = await supabase
    .from("developments")
    .select("id, name, city, neighborhood")
    .eq("tenant_id", tenantId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as Development[];
}

export async function salvarImovel(
  tenantId: string,
  p: Partial<Property> & { id?: string }
): Promise<void> {
  const linha = {
    tenant_id: tenantId,
    development_id: p.development_id || null,
    code: p.code || null,
    title: p.title,
    type: p.type,
    status: p.status ?? "AVAILABLE",
    city: p.city || null,
    state: p.state || null,
    neighborhood: p.neighborhood || null,
    price: p.price ?? null,
    condo_fee: p.condo_fee ?? null,
    area_m2: p.area_m2 ?? null,
    bedrooms: p.bedrooms ?? null,
    suites: p.suites ?? null,
    bathrooms: p.bathrooms ?? null,
    parking_spaces: p.parking_spaces ?? null,
    description: p.description || null,
    features: p.features ?? [],
  };
  const { error } = p.id
    ? await supabase.from("properties").update(linha).eq("id", p.id)
    : await supabase.from("properties").insert(linha);
  if (error) throw error;
}

export async function mudarStatusImovel(id: string, status: PropertyStatus) {
  const { error } = await supabase.from("properties").update({ status }).eq("id", id);
  if (error) throw error;
}

/* ================================================ interesse e matching === */

export async function interesse(oppId: string): Promise<LeadInterest | null> {
  const { data, error } = await supabase
    .from("lead_interests")
    .select("*")
    .eq("opportunity_id", oppId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as LeadInterest) ?? null;
}

export async function salvarInteresse(tenantId: string, i: LeadInterest) {
  const { error } = await supabase
    .from("lead_interests")
    .upsert({ ...i, tenant_id: tenantId }, { onConflict: "opportunity_id" });
  if (error) throw error;
}

export async function matches(oppId: string, limite = 6): Promise<Match[]> {
  const { data, error } = await supabase.rpc("match_imoveis", {
    p_opportunity_id: oppId,
    p_limite: limite,
  });
  if (error) throw error;
  return (data ?? []) as Match[];
}

/* =========================================================== visitas === */

const VISIT_COLS =
  "id, opportunity_id, property_id, broker_id, scheduled_at, status, notes," +
  " opportunity:opportunities(contact:contacts(id, full_name, phone))," +
  " property:properties(title)";

export async function visitas(
  tenantId: string,
  apenasMinhas?: string,
  status?: VisitStatus
): Promise<Visit[]> {
  let q = supabase
    .from("visits")
    .select(VISIT_COLS)
    .eq("tenant_id", tenantId)
    .order("scheduled_at", { ascending: true })
    .limit(120);
  if (apenasMinhas) q = q.eq("broker_id", apenasMinhas);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown[]).map(achatarContato) as unknown as Visit[];
}

export async function agendarVisita(args: {
  oppId: string; quando: string; propertyId?: string | null; notas?: string;
}) {
  const { error } = await supabase.rpc("agendar_visita", {
    p_opportunity_id: args.oppId,
    p_scheduled_at: args.quando,
    p_property_id: args.propertyId ?? null,
    p_notas: args.notas ?? null,
  });
  if (error) throw error;
}

export async function atualizarVisita(id: string, status: VisitStatus, notas?: string) {
  const { error } = await supabase.rpc("atualizar_visita", {
    p_visit_id: id, p_status: status, p_notas: notas ?? null,
  });
  if (error) throw error;
}

/* ========================================================= propostas === */

const PROP_P_COLS =
  "id, opportunity_id, property_id, broker_id, list_price, offered_price," +
  " down_payment, financing_amount, valid_until, status, notes, created_at," +
  " opportunity:opportunities(contact:contacts(id, full_name, phone))," +
  " property:properties(title)";

export async function propostas(
  tenantId: string,
  apenasMinhas?: string,
  oppId?: string
): Promise<Proposal[]> {
  let q = supabase
    .from("proposals")
    .select(PROP_P_COLS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(120);
  if (apenasMinhas) q = q.eq("broker_id", apenasMinhas);
  if (oppId) q = q.eq("opportunity_id", oppId);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown[]).map(achatarContato) as unknown as Proposal[];
}

export async function criarProposta(args: {
  oppId: string; valor: number; propertyId?: string | null;
  entrada?: number | null; financiamento?: number | null;
  validade?: string | null; notas?: string;
}) {
  const { error } = await supabase.rpc("criar_proposta", {
    p_opportunity_id: args.oppId,
    p_offered_price: args.valor,
    p_property_id: args.propertyId ?? null,
    p_list_price: null,
    p_down_payment: args.entrada ?? null,
    p_financing_amount: args.financiamento ?? null,
    p_valid_until: args.validade || null,
    p_notas: args.notas ?? null,
  });
  if (error) throw error;
}

export async function atualizarProposta(id: string, status: ProposalStatus, notas?: string) {
  const { error } = await supabase.rpc("atualizar_proposta", {
    p_proposal_id: id, p_status: status, p_notas: notas ?? null,
  });
  if (error) throw error;
}

/* ============================================================ vendas === */

export async function vendas(tenantId: string, apenasMinhas?: string): Promise<Sale[]> {
  let q = supabase
    .from("sales")
    .select(
      "id, opportunity_id, property_id, broker_id, sale_value, sold_at," +
        " cancelled_at, cancel_reason, source, campaign_name, ad_name," +
        " opportunity:opportunities(contact:contacts(id, full_name, phone))," +
        " property:properties(title)"
    )
    .eq("tenant_id", tenantId)
    .order("sold_at", { ascending: false })
    .limit(120);
  if (apenasMinhas) q = q.eq("broker_id", apenasMinhas);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown[]).map(achatarContato) as unknown as Sale[];
}

export async function registrarVenda(args: {
  oppId: string; valor: number; propertyId?: string | null; proposalId?: string | null;
}) {
  const { error } = await supabase.rpc("registrar_venda", {
    p_opportunity_id: args.oppId,
    p_sale_value: args.valor,
    p_property_id: args.propertyId ?? null,
    p_proposal_id: args.proposalId ?? null,
  });
  if (error) throw error;
}

export async function cancelarVenda(id: string, motivo: string) {
  const { error } = await supabase.rpc("cancelar_venda", {
    p_sale_id: id, p_motivo: motivo,
  });
  if (error) throw error;
}

/* ============================================================= filas === */

export async function filas(tenantId: string): Promise<Fila[]> {
  const { data, error } = await supabase
    .from("lead_queues")
    .select("id, name, status, acceptance_timeout_seconds, cursor_sort_order, timezone, working_hours")
    .eq("tenant_id", tenantId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as Fila[];
}

export async function membrosDaFila(queueId: string): Promise<MembroFila[]> {
  const { data, error } = await supabase
    .from("queue_members")
    .select("id, queue_id, user_id, sort_order, active, profile:profiles(full_name)")
    .eq("queue_id", queueId)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as unknown as MembroFila[];
}

export async function salvarFila(
  tenantId: string,
  f: {
    id?: string; name: string; acceptance_timeout_seconds: number;
    status?: "ACTIVE" | "INACTIVE";
    working_hours?: HorarioFila | Record<string, never>;
  }
) {
  const linha = {
    tenant_id: tenantId,
    name: f.name,
    acceptance_timeout_seconds: f.acceptance_timeout_seconds,
    status: f.status ?? "ACTIVE",
    working_hours: f.working_hours ?? {},
  };
  const { error } = f.id
    ? await supabase.from("lead_queues").update(linha).eq("id", f.id)
    : await supabase.from("lead_queues").insert(linha);
  if (error) throw error;
}

export async function definirMembros(
  tenantId: string,
  queueId: string,
  userIds: string[]
) {
  const { error: e1 } = await supabase.from("queue_members").delete().eq("queue_id", queueId);
  if (e1) throw e1;
  if (userIds.length === 0) return;
  const { error: e2 } = await supabase.from("queue_members").insert(
    userIds.map((user_id, i) => ({
      tenant_id: tenantId, queue_id: queueId, user_id, sort_order: i, active: true,
    }))
  );
  if (e2) throw e2;
}

export async function distribuirLead(oppId: string, queueId: string) {
  const { error } = await supabase.rpc("distribuir_lead", {
    p_opportunity_id: oppId, p_queue_id: queueId,
  });
  if (error) throw error;
}

export async function aceitarLead(assignmentId: string) {
  const { error } = await supabase.rpc("aceitar_lead", { p_assignment_id: assignmentId });
  if (error) throw error;
}

export async function atribuicaoPendente(oppId: string): Promise<{ id: string; expires_at: string } | null> {
  const { data, error } = await supabase
    .from("lead_assignments")
    .select("id, expires_at")
    .eq("opportunity_id", oppId)
    .eq("status", "PENDING")
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; expires_at: string } | null;
}

/* O PostgREST devolve o contato aninhado dentro de opportunity; achatar aqui
   evita x.opportunity?.contact?.full_name espalhado por cinco telas.
   Recebe unknown porque o supabase-js nao consegue inferir select aninhado. */
function achatarContato(linha: unknown): unknown {
  const l = linha as { opportunity?: { contact?: unknown } | null };
  return { ...(l as object), contact: l.opportunity?.contact ?? null };
}
