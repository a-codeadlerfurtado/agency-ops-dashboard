import { describe, expect, it } from "vitest";
import { matchClientsToCustomers } from "../../supabase/functions/_shared/billing/document.ts";

const CNPJ_A = "12345678000195";
const CNPJ_B = "98765432000112";

describe("matchClientsToCustomers", () => {
  it("casa cliente e customer pelo documento, ignorando pontuacao", () => {
    const result = matchClientsToCustomers(
      [{ client_id: "c1", document: "12.345.678/0001-95" }],
      [{ asaas_customer_id: "cus_1", cpfCnpj: CNPJ_A }],
    );
    expect(result.matched).toEqual([
      { client_id: "c1", asaas_customer_id: "cus_1", matched_document: CNPJ_A },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("NAO casa quando dois clientes dividem o mesmo documento", () => {
    const result = matchClientsToCustomers(
      [
        { client_id: "c1", document: CNPJ_A },
        { client_id: "c2", document: CNPJ_A },
      ],
      [{ asaas_customer_id: "cus_1", cpfCnpj: CNPJ_A }],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([
      { document: CNPJ_A, client_ids: ["c1", "c2"], asaas_customer_ids: ["cus_1"] },
    ]);
  });

  it("NAO casa quando dois customers dividem o mesmo documento", () => {
    const result = matchClientsToCustomers(
      [{ client_id: "c1", document: CNPJ_A }],
      [
        { asaas_customer_id: "cus_1", cpfCnpj: CNPJ_A },
        { asaas_customer_id: "cus_2", cpfCnpj: CNPJ_A },
      ],
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguous[0].asaas_customer_ids).toEqual(["cus_1", "cus_2"]);
  });

  it("separa cliente sem documento de cliente sem customer", () => {
    const result = matchClientsToCustomers(
      [
        { client_id: "sem_doc", document: null },
        { client_id: "sem_cus", document: CNPJ_B },
      ],
      [],
    );
    expect(result.clients_without_document).toEqual(["sem_doc"]);
    expect(result.clients_without_customer).toEqual(["sem_cus"]);
  });

  it("lista customer do Asaas que nao corresponde a nenhum cliente", () => {
    const result = matchClientsToCustomers([], [{ asaas_customer_id: "cus_9", cpfCnpj: CNPJ_B }]);
    expect(result.customers_without_client).toEqual(["cus_9"]);
  });

  it("trata documento invalido do Asaas como ausente", () => {
    const result = matchClientsToCustomers(
      [{ client_id: "c1", document: CNPJ_A }],
      [{ asaas_customer_id: "cus_1", cpfCnpj: "123" }],
    );
    expect(result.matched).toEqual([]);
    expect(result.clients_without_customer).toEqual(["c1"]);
    expect(result.customers_without_client).toEqual(["cus_1"]);
  });
});
