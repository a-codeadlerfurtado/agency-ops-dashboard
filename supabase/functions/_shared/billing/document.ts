import type {
  AmbiguousDocument,
  AsaasCustomer,
  ClientDocument,
  MatchResult,
  MatchedPair,
} from "./types.ts";

/** Normaliza CNPJ (14) ou CPF (11) para so digitos. Devolve null se nao for nenhum dos dois. */
export function normalizeDocument(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 14) return null;
  return digits;
}

/**
 * Casa clientes e customers do Asaas pelo documento fiscal normalizado.
 * Um documento com mais de um cliente OU mais de um customer nunca vira par:
 * vai para `ambiguous` e exige decisao humana.
 */
export function matchClientsToCustomers(
  clients: ClientDocument[],
  customers: AsaasCustomer[],
): MatchResult {
  const clientsByDoc = new Map<string, string[]>();
  const clients_without_document: string[] = [];

  for (const client of clients) {
    const doc = normalizeDocument(client.document);
    if (!doc) {
      clients_without_document.push(client.client_id);
      continue;
    }
    const bucket = clientsByDoc.get(doc);
    if (bucket) bucket.push(client.client_id);
    else clientsByDoc.set(doc, [client.client_id]);
  }

  const customersByDoc = new Map<string, string[]>();
  const customers_without_client: string[] = [];

  for (const customer of customers) {
    const doc = normalizeDocument(customer.cpfCnpj);
    if (!doc) {
      customers_without_client.push(customer.asaas_customer_id);
      continue;
    }
    const bucket = customersByDoc.get(doc);
    if (bucket) bucket.push(customer.asaas_customer_id);
    else customersByDoc.set(doc, [customer.asaas_customer_id]);
  }

  const matched: MatchedPair[] = [];
  const ambiguous: AmbiguousDocument[] = [];
  const clients_without_customer: string[] = [];

  for (const [document, client_ids] of clientsByDoc) {
    const asaas_customer_ids = customersByDoc.get(document) || [];
    if (asaas_customer_ids.length === 0) {
      clients_without_customer.push(...client_ids);
      continue;
    }
    if (client_ids.length > 1 || asaas_customer_ids.length > 1) {
      ambiguous.push({ document, client_ids, asaas_customer_ids });
      continue;
    }
    matched.push({
      client_id: client_ids[0],
      asaas_customer_id: asaas_customer_ids[0],
      matched_document: document,
    });
  }

  for (const [document, asaas_customer_ids] of customersByDoc) {
    if (!clientsByDoc.has(document)) customers_without_client.push(...asaas_customer_ids);
  }

  return {
    matched,
    ambiguous,
    clients_without_document,
    clients_without_customer,
    customers_without_client,
  };
}
