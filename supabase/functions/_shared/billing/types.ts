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
