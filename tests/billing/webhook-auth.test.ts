import { describe, expect, it } from "vitest";
import { isAuthorizedWebhookToken } from "../../supabase/functions/_shared/billing/webhook-auth.ts";

describe("isAuthorizedWebhookToken", () => {
  it("aceita token igual", () => {
    expect(isAuthorizedWebhookToken("segredo-123", "segredo-123")).toBe(true);
  });

  it("recusa token diferente", () => {
    expect(isAuthorizedWebhookToken("errado", "segredo-123")).toBe(false);
  });

  it("recusa quando o segredo do servidor esta ausente ou vazio", () => {
    expect(isAuthorizedWebhookToken("qualquer", null)).toBe(false);
    expect(isAuthorizedWebhookToken("qualquer", undefined)).toBe(false);
    expect(isAuthorizedWebhookToken("qualquer", "")).toBe(false);
    expect(isAuthorizedWebhookToken("qualquer", "   ")).toBe(false);
  });

  it("recusa quando os dois lados estao vazios", () => {
    expect(isAuthorizedWebhookToken("", "")).toBe(false);
    expect(isAuthorizedWebhookToken(null, null)).toBe(false);
  });

  it("recusa token ausente com segredo configurado", () => {
    expect(isAuthorizedWebhookToken(null, "segredo-123")).toBe(false);
  });

  it("nao aceita prefixo do segredo", () => {
    expect(isAuthorizedWebhookToken("segredo", "segredo-123")).toBe(false);
    expect(isAuthorizedWebhookToken("segredo-1234", "segredo-123")).toBe(false);
  });
});
