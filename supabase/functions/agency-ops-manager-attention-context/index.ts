import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TZ = "America/Sao_Paulo";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clip = (value: unknown, max = 360) => {
  const raw = String(value ?? "").trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
};
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();
const localDateTime = (value: unknown) => {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
};
const timeOnly = (value: unknown) => {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
};
const isGreetingOnly = (body: unknown) => {
  const q = norm(body);
  if (!/^(bom dia|boa tarde|boa noite)/.test(q)) return false;
  return !/(preciso|retorno|google|campanh|lead|credito|palavr|whats|resultado|saldo|problema|ajust|verific|averigu|cobrar|como eu|quero saber)/.test(q);
};
const isMeaningful = (row: any) => {
  const body = String(row?.body || "").trim();
  if (body.length >= 3) return true;
  return ["image", "video", "document", "audio"].includes(String(row?.message_type || "").toLowerCase());
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE) return json({ ok: false, error: "server_configuration" }, 500);

  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const url = new URL(req.url);
  const alertId = String(url.searchParams.get("alert_id") || "").trim();
  if (!alertId) return json({ ok: false, error: "alert_id_required" }, 400);

  const [{ data: preference }, { data: alert, error: alertError }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("manager_attention_alerts")
      .select("id,client_id,client_name,context,situation,charge_action,owner_person,owner_area,first_seen_at,last_seen_at,allowed_people")
      .eq("id", alertId)
      .maybeSingle(),
  ]);
  if (alertError) return json({ ok: false, error: alertError.message }, 500);
  if (!alert) return json({ ok: false, error: "alert_not_found" }, 404);

  const person = String(preference?.collaborator_person || preference?.name || "").trim();
  const allowed = Array.isArray(alert.allowed_people) ? alert.allowed_people.map((x: unknown) => String(x)) : [];
  if (!person || !allowed.includes(person)) return json({ ok: false, error: "forbidden" }, 403);
  if (!alert.client_id) return json({ ok: true, alert, explanation: "Este alerta não está vinculado a um cliente com conversa de WhatsApp.", latest_session: [], origin_thread: [] });

  const { data: chats, error: chatsError } = await ops.from("whatsapp_chat_registry")
    .select("chat_id,chat_name,scope,confidence")
    .eq("client_id", alert.client_id)
    .eq("scope", "CLIENT")
    .order("last_seen_at", { ascending: false });
  if (chatsError) return json({ ok: false, error: chatsError.message }, 500);
  const chatIds = [...new Set((chats || []).map((row: any) => String(row.chat_id)).filter(Boolean))];
  if (!chatIds.length) return json({ ok: true, alert, explanation: "Não encontrei um grupo de cliente vinculado para recuperar a conversa.", latest_session: [], origin_thread: [] });

  const anchorAt = new Date(alert.first_seen_at || Date.now());
  const start = new Date(anchorAt.getTime() - 30 * 60 * 60 * 1000).toISOString();
  const end = new Date(Math.max(Date.now(), anchorAt.getTime()) + 10 * 60 * 1000).toISOString();

  const [{ data: rawMessages, error: messagesError }, { data: actors }, { data: identities }] = await Promise.all([
    ops.from("whatsapp_messages")
      .select("id,message_id,chat_id,chat_name,sender_name,message_type,text_body,caption,event_at")
      .in("chat_id", chatIds)
      .gte("event_at", start)
      .lte("event_at", end)
      .order("event_at", { ascending: true })
      .limit(160),
    ops.from("whatsapp_message_actor")
      .select("chat_id,event_at,pessoa,papel,da_equipe")
      .in("chat_id", chatIds)
      .gte("event_at", start)
      .lte("event_at", end)
      .order("event_at", { ascending: true }),
    ops.from("whatsapp_participant_identity")
      .select("chat_id,phone,sender_lid,canonical_name,role_hint,side,confidence")
      .in("chat_id", chatIds)
      .order("confidence", { ascending: false }),
  ]);
  if (messagesError) return json({ ok: false, error: messagesError.message }, 500);

  const actorMap = new Map<string, any>();
  for (const row of actors || []) {
    const key = `${row.chat_id}|${new Date(row.event_at).toISOString()}`;
    actorMap.set(key, row);
  }

  const mentionMap = new Map<string, string>();
  for (const row of identities || []) {
    const name = String(row.canonical_name || "").trim();
    if (!name) continue;
    const phone = String(row.phone || "").replace(/\D/g, "");
    const lid = String(row.sender_lid || "").split("@")[0].replace(/\D/g, "");
    if (phone) mentionMap.set(phone, name);
    if (lid) mentionMap.set(lid, name);
  }
  const resolveMentions = (value: unknown) => String(value ?? "").replace(/@(\d{8,})/g, (whole, digits) => {
    const name = mentionMap.get(String(digits));
    return name ? `@${name}` : whole;
  });

  const messages = (rawMessages || []).map((row: any) => {
    const key = `${row.chat_id}|${new Date(row.event_at).toISOString()}`;
    const actor = actorMap.get(key);
    const bodyRaw = String(row.text_body || row.caption || "").trim();
    const body = resolveMentions(bodyRaw || (row.message_type ? `[${row.message_type}]` : "[mensagem]"));
    return {
      id: String(row.id),
      message_id: row.message_id,
      event_at: row.event_at,
      chat_name: row.chat_name,
      sender_name: String(actor?.pessoa || row.sender_name || (actor?.da_equipe ? "Equipe" : "Cliente")).trim(),
      role: actor?.papel || null,
      is_team: Boolean(actor?.da_equipe),
      message_type: row.message_type,
      body: clip(body, 420),
    };
  }).filter(isMeaningful).sort((a: any, b: any) => new Date(a.event_at).getTime() - new Date(b.event_at).getTime());

  let sessionStart = Math.max(0, messages.length - 1);
  for (let i = messages.length - 1; i > 0; i--) {
    const gap = new Date(messages[i].event_at).getTime() - new Date(messages[i - 1].event_at).getTime();
    if (gap > 4 * 60 * 60 * 1000) { sessionStart = i; break; }
    sessionStart = i - 1;
  }
  let latestSession = messages.slice(sessionStart).filter((row: any) => !isGreetingOnly(row.body));
  if (!latestSession.length) latestSession = messages.slice(-6);
  latestSession = latestSession.slice(-8);

  let origin: any = null;
  const contextMatch = String(alert.context || "").match(/(\d{2})\/(\d{2}),\s*(\d{2}):(\d{2})/);
  if (contextMatch) {
    const target = `${contextMatch[1]}/${contextMatch[2]}, ${contextMatch[3]}:${contextMatch[4]}`;
    origin = messages.find((row: any) => localDateTime(row.event_at) === target && !row.is_team)
      || messages.find((row: any) => localDateTime(row.event_at) === target)
      || null;
  }
  if (!origin) {
    origin = [...messages].reverse().find((row: any) => !row.is_team && new Date(row.event_at) <= anchorAt) || null;
  }

  let originThread: any[] = [];
  if (origin) {
    const originAt = new Date(origin.event_at).getTime();
    originThread = messages.filter((row: any) => {
      const at = new Date(row.event_at).getTime();
      return at >= originAt - 8 * 60 * 1000 && at <= originAt + 10 * 60 * 1000 && !isGreetingOnly(row.body);
    }).slice(-8);
  }

  const latestClients = latestSession.filter((row: any) => !row.is_team);
  const latestTeams = latestSession.filter((row: any) => row.is_team);
  const firstLatestClient = latestClients[0] || null;
  const lastLatestClient = latestClients[latestClients.length - 1] || null;
  const lastTeam = latestTeams[latestTeams.length - 1] || null;
  const teamAfterClient = Boolean(lastTeam && lastLatestClient && new Date(lastTeam.event_at) > new Date(lastLatestClient.event_at));
  const handoff = teamAfterClient && /(@|averigu|verific|checar|conferir|olhar isso|dar uma olhada)/.test(norm(lastTeam.body));
  const mentions = lastTeam ? [...String(lastTeam.body).matchAll(/@([^,!?\n]+)/g)].map((m) => String(m[1]).trim()).filter(Boolean) : [];

  let explanation = String(alert.context || "").trim() || "O radar encontrou uma pendência sem fechamento comprovado.";
  if (firstLatestClient) {
    const prefix = origin && new Date(origin.event_at).getTime() < new Date(firstLatestClient.event_at).getTime() - 4 * 60 * 60 * 1000
      ? `O alerta já vinha de uma cobrança de ${localDateTime(origin.event_at)}. `
      : "";
    if (!teamAfterClient) {
      explanation = `${prefix}O cliente voltou a cobrar às ${timeOnly(firstLatestClient.event_at)}${latestClients.length > 1 ? ` e detalhou o assunto em ${latestClients.length} mensagens` : ""}. Até o corte do radar, não há retorno posterior da equipe.`;
    } else if (handoff) {
      const target = mentions.length ? ` para ${mentions.join(", ")}` : alert.owner_person ? ` para ${alert.owner_person}` : " ao responsável";
      explanation = `${prefix}O cliente voltou a cobrar às ${timeOnly(firstLatestClient.event_at)}${latestClients.length > 1 ? ` e detalhou o assunto em ${latestClients.length} mensagens` : ""}. ${lastTeam.sender_name || "A equipe"} encaminhou${target} às ${timeOnly(lastTeam.event_at)}, mas não há mensagem posterior de execução ou fechamento até o corte.`;
    } else {
      explanation = `${prefix}O cliente voltou a cobrar às ${timeOnly(firstLatestClient.event_at)}. Houve resposta da equipe às ${timeOnly(lastTeam.event_at)}, porém o radar ainda não encontrou evidência posterior de execução ou fechamento.`;
    }
  }

  const serialize = (rows: any[]) => rows.map((row: any) => ({
    id: row.id,
    event_at: row.event_at,
    sender_name: row.sender_name,
    role: row.role,
    is_team: row.is_team,
    message_type: row.message_type,
    body: row.body,
  }));

  return json({
    ok: true,
    alert: {
      id: alert.id,
      client_name: alert.client_name,
      context: alert.context,
      situation: alert.situation,
      charge_action: alert.charge_action,
      owner_person: alert.owner_person,
      owner_area: alert.owner_area,
    },
    explanation,
    origin_at: origin?.event_at || null,
    latest_session: serialize(latestSession),
    origin_thread: serialize(originThread),
    generated_at: new Date().toISOString(),
  });
});
