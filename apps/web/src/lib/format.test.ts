import { describe, expect, it } from "vitest";
import {
  diasDesde, dinheiro, dinheiroCurto, iniciais, linkWhatsapp,
  primeiroNome, rotuloOrigem,
} from "./format";

/**
 * A normalizacao autoritativa e a do banco (imobi_board_priv.normalize_phone_br),
 * porque o indice unico de deduplicacao depende dela. Estes casos sao os MESMOS
 * de supabase/tests/rls_test.sql: se as duas implementacoes divergirem, um
 * telefone abriria contato duplicado por um caminho e nao por outro.
 */
describe("linkWhatsapp", () => {
  it("colapsa as grafias do mesmo celular num numero so", () => {
    const esperado = "https://wa.me/5511996634567";
    for (const entrada of [
      "(11) 99663-4567",
      "11996634567",
      "5511996634567",
      "+55 11 99663-4567",
      "11 9663-4567", // celular antigo, sem o nono digito
    ]) {
      expect(linkWhatsapp(entrada), entrada).toBe(esperado);
    }
  });

  it("preserva fixo sem inventar o nono digito", () => {
    expect(linkWhatsapp("(61) 3245-1200")).toBe("https://wa.me/556132451200");
  });

  it("recusa numero sem DDD ou invalido", () => {
    expect(linkWhatsapp("99663-4567")).toBeNull();
    expect(linkWhatsapp("abc")).toBeNull();
    expect(linkWhatsapp("")).toBeNull();
    expect(linkWhatsapp(null)).toBeNull();
  });
});

describe("dinheiroCurto", () => {
  it("encurta milhao e milhar, que e como o corretor fala", () => {
    expect(dinheiroCurto(3_490_000)).toBe("R$ 3,49 mi");
    expect(dinheiroCurto(875_000)).toBe("R$ 875 mil");
    expect(dinheiroCurto(1_000_000)).toBe("R$ 1,00 mi");
  });

  it("nao encurta valor pequeno", () => {
    expect(dinheiroCurto(850)).toContain("850");
  });

  it("distingue zero de ausente", () => {
    expect(dinheiroCurto(null)).toBe("--");
    expect(dinheiroCurto(undefined)).toBe("--");
    expect(dinheiroCurto(0)).toContain("0");
  });
});

describe("dinheiro", () => {
  it("formata em real", () => {
    expect(dinheiro(875_000).replace(/ /g, " ")).toBe("R$ 875.000");
    expect(dinheiro(null)).toBe("--");
  });
});

describe("iniciais", () => {
  it("usa primeiro e ultimo nome", () => {
    expect(iniciais("Joao Silva")).toBe("JS");
    expect(iniciais("Ana Beatriz Souza")).toBe("AS");
  });

  it("aguenta nome unico e vazio", () => {
    expect(iniciais("Madonna")).toBe("M");
    expect(iniciais(null)).toBe("?");
    expect(iniciais("  ")).toBe("?");
  });
});

describe("primeiroNome", () => {
  it("pega so o primeiro", () => {
    expect(primeiroNome("Carlos Menezes")).toBe("Carlos");
    expect(primeiroNome(null)).toBe("");
  });
});

describe("rotuloOrigem", () => {
  it("traduz o que conhece e devolve cru o que nao conhece", () => {
    expect(rotuloOrigem("META_ADS")).toBe("Meta Ads");
    expect(rotuloOrigem("INDICACAO")).toBe("Indicacao");
    expect(rotuloOrigem("TIKTOK")).toBe("TIKTOK");
  });
});

describe("diasDesde", () => {
  it("conta dias corridos", () => {
    const trintaDias = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(diasDesde(trintaDias)).toBe(30);
  });

  it("trata ausencia como zero", () => {
    expect(diasDesde(null)).toBe(0);
  });
});
