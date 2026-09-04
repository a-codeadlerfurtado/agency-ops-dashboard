export type ChargeKind = "MENSALIDADE" | "IMPLANTACAO" | "EXTRA";
/**
 * Vocabulario imposto pelo CHECK de agency_ops.client_finance_controls.
 * CURRENT, DUE_SOON e OVERDUE ja existem no banco; DELINQUENT e acrescentado
 * pela migration da Task 7. Nao inventar valores: o insert falha.
 */
export type PaymentStatus = "CURRENT" | "DUE_SOON" | "OVERDUE" | "DELINQUENT";

export interface ClientDocument {
  client_id: string;
  document: string | null;
}

export interface AsaasCustomer {
  asaas_customer_id: string;
  cpfCnpj: string | null;
}

export interface MatchedPair {
  client_id: string;
  asaas_customer_id: string;
  matched_document: string;
}

export interface AmbiguousDocument {
  document: string;
  client_ids: string[];
  asaas_customer_ids: string[];
}

export interface MatchResult {
  matched: MatchedPair[];
  ambiguous: AmbiguousDocument[];
  clients_without_document: string[];
  clients_without_customer: string[];
  customers_without_client: string[];
}

export interface AsaasPayment {
  id: string;
  customer?: string | null;
  subscription?: string | null;
  value?: number | string | null;
  netValue?: number | string | null;
  dueDate?: string | null;
  status?: string | null;
  billingType?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  description?: string | null;
}

export interface BillingChargeRow {
  asaas_payment_id: string;
  client_id: string | null;
  /** Elo independente de client_id: sobrevive ao elo ainda nao confirmado. */
  asaas_customer_id: string | null;
  asaas_subscription_id: string | null;
  kind: ChargeKind;
  value: number;
  net_value: number | null;
  due_date: string;
  status: string;
  billing_type: string | null;
  payment_date: string | null;
  invoice_url: string | null;
  bank_slip_url: string | null;
  description: string | null;
  raw: unknown;
}

export interface ChargeSnapshot {
  due_date: string;
  status: string;
  payment_date: string | null;
}

export interface DeriveStatusInput {
  charges: ChargeSnapshot[];
  today: string;
  /** Dias de atraso a partir dos quais o cliente e DELINQUENT. Default 5. */
  overdueDays?: number;
  /** Antecedencia que marca DUE_SOON. Default 3. */
  dueSoonDays?: number;
}

export interface DerivedFinanceControl {
  payment_status: PaymentStatus;
  overdue_since: string | null;
  next_due_date: string | null;
  last_payment_at: string | null;
  days_late: number;
}
