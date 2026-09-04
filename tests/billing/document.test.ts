import { describe, expect, it } from "vitest";
import { normalizeDocument } from "../../supabase/functions/_shared/billing/document.ts";

describe("normalizeDocument", () => {
  it("remove pontuacao de CNPJ", () => {
    expect(normalizeDocument("12.345.678/0001-95")).toBe("12345678000195");
  });

  it("remove pontuacao de CPF", () => {
    expect(normalizeDocument("123.456.789-09")).toBe("12345678909");
  });

  it("aceita documento ja limpo", () => {
    expect(normalizeDocument("12345678000195")).toBe("12345678000195");
  });

  it("devolve null para vazio, nulo e indefinido", () => {
    expect(normalizeDocument("")).toBeNull();
    expect(normalizeDocument("   ")).toBeNull();
    expect(normalizeDocument(null)).toBeNull();
    expect(normalizeDocument(undefined)).toBeNull();
  });

  it("devolve null para comprimento invalido", () => {
    expect(normalizeDocument("123")).toBeNull();
    expect(normalizeDocument("123456789012345")).toBeNull();
  });

  it("devolve null quando so ha pontuacao", () => {
    expect(normalizeDocument("../-.")).toBeNull();
  });
});
