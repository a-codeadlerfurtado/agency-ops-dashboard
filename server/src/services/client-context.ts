import { ops } from "./supabase.js";
import type { ClientRow } from "./permissions.js";

/**
 * Contexto do cliente montado por recuperacao seletiva.
 *
 * O banco inteiro nao vai para o modelo: buscamos so' as visoes que respondem
 * "como este cliente esta hoje", cada uma limitada ao registro mais recente.
 */
export async function buildClientContext(client: ClientRow | null) {
  if (!client?.client_id) return null;
  const clientId = String(client.client_id);

  const [campaign, health, conversation, service] = await Promise.all([
    ops.from("campaign_client_latest").select("*").eq("client_id", clientId).maybeSingle(),
    ops
      .from("client_health_scores")
      .select("*")
      .eq("client_id", clientId)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    ops
      .from("conversation_state")
      .select("*")
      .eq("client_id", clientId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    ops.from("client_service_overview").select("*").eq("client_id", clientId).maybeSingle(),
  ]);

  return {
    overview: client,
    campaign: campaign.data ?? null,
    health: health.data ?? null,
    conversation: conversation.data ?? null,
    services: service.data ?? null,
  };
}

/**
 * Evidencia operacional do OpsQuestion, usada como fonte interna adicional.
 * Falha silenciosa de proposito: o chat nao pode cair porque o fallback caiu.
 */
export async function operationalEvidence(
  supabaseUrl: string,
  publishableKey: string,
  accessToken: string,
  question: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: publishableKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    if (response.ok && body?.ok && body.answer) return String(body.answer);
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
