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
  contact?: Contact | null;
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
}
