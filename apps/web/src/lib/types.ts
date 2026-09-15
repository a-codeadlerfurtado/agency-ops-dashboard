export type Role = "ADMIN" | "BROKER";

export type StageKind =
  | "NEW" | "CONTACTED" | "QUALIFIED" | "VISIT" | "PROPOSAL" | "WON" | "LOST";

export type OppStatus = "OPEN" | "WON" | "LOST";

export type ActivityType =
  | "NOTE" | "CALL" | "WHATSAPP" | "EMAIL" | "MEETING"
  | "STATUS_CHANGE" | "VISIT" | "PROPOSAL" | "SYSTEM";

export type TaskStatus = "OPEN" | "DONE" | "CANCELLED";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
}

export interface Membership {
  id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  status: "ACTIVE" | "INACTIVE";
}

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
}

export interface Stage {
  id: string;
  name: string;
  kind: StageKind;
  sort_order: number;
  pipeline_id: string;
}

export interface Contact {
  id: string;
  full_name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
}

export interface Opportunity {
  id: string;
  tenant_id: string;
  contact_id: string;
  assigned_user_id: string | null;
  stage_id: string;
  status: OppStatus;
  source: string;
  source_detail: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  created_at: string;
  accepted_at: string | null;
  first_contact_at: string | null;
  qualified_at: string | null;
  closed_at: string | null;
  last_interaction_at: string;
  lost_reason: string | null;
  /* Produto da oportunidade (spec 71/72). Carimbado pela trigger da 0023
     quando o lead ganha visita, proposta ou venda. */
  property_id: string | null;
  development_id: string | null;
  contact?: Contact | null;
  property?: { id: string; code: string | null; title: string } | null;
  development?: { id: string; name: string } | null;
}

export interface Activity {
  id: string;
  opportunity_id: string;
  type: ActivityType;
  body: string | null;
  from_stage_id: string | null;
  to_stage_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  opportunity_id: string | null;
  assigned_user_id: string;
  title: string;
  description: string | null;
  due_at: string;
  completed_at: string | null;
  status: TaskStatus;
}

/** Sessao resolvida: quem sou, em qual imobiliaria e com qual papel. */
export interface Sessao {
  userId: string;
  email: string;
  nome: string;
  tenant: Tenant;
  role: Role;
  isAdmin: boolean;
  /** dono da operacao: pode criar imobiliaria */
  ehOperador?: boolean;
}

/* ---------------------------------------------- imoveis e pos-qualificacao */

export type PropertyType =
  | "APARTAMENTO" | "CASA" | "SOBRADO" | "COBERTURA"
  | "TERRENO" | "SALA" | "GALPAO" | "CHACARA";

export type PropertyStatus = "AVAILABLE" | "RESERVED" | "SOLD" | "INACTIVE";
export type VisitStatus = "SCHEDULED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
export type ProposalStatus =
  | "DRAFT" | "SENT" | "NEGOTIATING" | "ACCEPTED" | "REJECTED" | "CANCELLED";
export type PurchasePurpose = "MORAR" | "INVESTIR" | "INDEFINIDO";

export interface Development {
  id: string;
  name: string;
  city: string | null;
  neighborhood: string | null;
}

export interface Property {
  id: string;
  development_id: string | null;
  code: string | null;
  title: string;
  type: PropertyType;
  status: PropertyStatus;
  city: string | null;
  state: string | null;
  neighborhood: string | null;
  price: number | null;
  condo_fee: number | null;
  area_m2: number | null;
  bedrooms: number | null;
  suites: number | null;
  bathrooms: number | null;
  parking_spaces: number | null;
  description: string | null;
  features: string[];
  development?: Development | null;
}

export interface LeadInterest {
  id?: string;
  opportunity_id: string;
  purchase_purpose: PurchasePurpose;
  property_type: PropertyType | null;
  cities: string[];
  neighborhoods: string[];
  min_price: number | null;
  max_price: number | null;
  min_area: number | null;
  max_area: number | null;
  min_bedrooms: number | null;
  min_suites: number | null;
  min_parking_spaces: number | null;
  financing_needed: boolean | null;
  down_payment: number | null;
  purchase_timeframe: string | null;
  notes: string | null;
}

export interface MotivoMatch {
  criterio: "bairro" | "preco" | "tipo" | "quartos" | "area" | "vagas";
  peso: number;
  pontos: number;
  situacao: "atende" | "parcial" | "nao_atende" | "nao_informado";
}

export interface Match {
  property_id: string;
  titulo: string;
  bairro: string | null;
  cidade: string | null;
  preco: number | null;
  area_m2: number | null;
  quartos: number | null;
  vagas: number | null;
  tipo: PropertyType;
  score: number;
  motivos: MotivoMatch[];
}

export interface Visit {
  id: string;
  opportunity_id: string;
  property_id: string | null;
  broker_id: string;
  scheduled_at: string;
  status: VisitStatus;
  notes: string | null;
  contact?: Contact | null;
  property?: { title: string } | null;
}

export interface Proposal {
  id: string;
  opportunity_id: string;
  property_id: string | null;
  broker_id: string;
  list_price: number | null;
  offered_price: number;
  down_payment: number | null;
  financing_amount: number | null;
  valid_until: string | null;
  status: ProposalStatus;
  notes: string | null;
  created_at: string;
  contact?: Contact | null;
  property?: { title: string } | null;
}

export interface Sale {
  id: string;
  opportunity_id: string;
  property_id: string | null;
  broker_id: string;
  sale_value: number;
  sold_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  source: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  contact?: Contact | null;
  property?: { title: string } | null;
}

export interface HorarioFila {
  /** isodow: 1=segunda ... 7=domingo */
  dias: number[];
  inicio: string;
  fim: string;
}

export interface Fila {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  acceptance_timeout_seconds: number;
  cursor_sort_order: number;
  timezone?: string;
  /** {} = atende 24x7 */
  working_hours?: HorarioFila | Record<string, never>;
}

export interface MembroFila {
  id: string;
  queue_id: string;
  user_id: string;
  sort_order: number;
  active: boolean;
  profile?: { full_name: string | null } | null;
}
