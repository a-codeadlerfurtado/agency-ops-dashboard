import { describe, expect, it } from "vitest";
import { classifyChargeKind } from "../../supabase/functions/_shared/billing/charge-kind.ts";

describe("classifyChargeKind", () => {
  it("cobranca ligada a assinatura e mensalidade", () => {
    expect(classifyChargeKind({ subscriptionId: "sub_1", description: "qualquer coisa" }))
      .toBe("MENSALIDADE");
  });

  it("assinatura vence a descricao de implantacao", () => {
    expect(classifyChargeKind({ subscriptionId: "sub_1", description: "Implantacao" }))
      .toBe("MENSALIDADE");
  });

  it("avulsa com descricao de implantacao", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "Implantacao parcela 1/3" }))
      .toBe("IMPLANTACAO");
  });

  it("reconhece implantacao sem acento e com caixa alta", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "IMPLANTAÇÃO INICIAL" }))
      .toBe("IMPLANTACAO");
    expect(classifyChargeKind({ subscriptionId: null, description: "setup do projeto" }))
      .toBe("IMPLANTACAO");
    expect(classifyChargeKind({ subscriptionId: null, description: "Taxa de implementacao" }))
      .toBe("IMPLANTACAO");
  });

  it("avulsa sem palavra-chave e extra", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "Trafego adicional" }))
      .toBe("EXTRA");
  });

  it("avulsa sem descricao e extra", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: null })).toBe("EXTRA");
    expect(classifyChargeKind({ subscriptionId: "", description: "" })).toBe("EXTRA");
  });

  it("discrimina acento dentro da raiz da palavra implanta", () => {
    expect(classifyChargeKind({ subscriptionId: null, description: "ÍMPLANTAÇÃO" }))
      .toBe("IMPLANTACAO");
  });
});
