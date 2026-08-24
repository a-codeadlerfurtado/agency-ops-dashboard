import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const clip = (value: unknown, max = 260) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const fmtDate = (value: unknown) => {
  const raw = String(value ?? "");
  const exact = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exact) return `${exact[3]}/${exact[2]}/${exact[1]}`;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(raw));
};

const fmtDateTime = (value: unknown) => new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(String(value)));

function resolveClient(question: string, clients: any[]) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  for (const client of clients) {
    const name = norm(client.display_name);
    if (!name || name.length < 3) continue;
    if (q.includes(` ${name} `) && name.length + 1000 > score) {
      best = client;
      score = name.length + 1000;
      continue;
    }
    const parts = name.split(" ").filter((part) => part.length >= 4);
    const partial = parts.filter((part) => q.includes(` ${part} `)).reduce((sum, part) => sum + part.length, 0);
    if (partial >= Math.max(5, Math.floor(name.length * 0.5)) && partial > score) {
      best = client;
      score = partial;
    }
  }
  return best;
}

const SALE_INTENT = /\b(vendeu|venderam|venda|vendas|vender|fechou venda|fecharam venda|venda fechada|venda realizada)\b/;
const RANKING_INTENT = /\b(quem mais|mais vendeu|vendeu mais|ranking|por cliente|ranking de vendas)\b/;
const QUANTITY_INTENT = /\b(quantas|quantos|quantidade|numero de vendas|total de vendas)\b/;
const STRONG_SALE = /\b(saiu (uma|[0-9]+) vendas?|fechamos ([0-9]+ )?vendas?|fizemos ([0-9]+ )?vendas?|realizamos ([0-9]+ )?vendas?|venda (foi )?(fechada|realizada|concluida)|imovel (foi )?vendid[oa]|apartamento (foi )?vendid[oa]|casa (foi )?vendid[oa]|vendemos( [0-9]+)?|cliente comprou|comprador fechou)\b/;

function senderIsInternal(message: any, identities: any[]) {
  const phone = String(message.sender_phone ?? "").replace(/[^0-9]/g, "");
  const name = norm(message.sender_name);
  return identities.some((identity) => {
    if (!identity?.identity_value) return false;
    if (identity.identity_type === "PHONE") return String(identity.identity_value).replace(/[^0-9]/g, "") === phone && Boolean(phone);
    if (identity.identity_type === "NAME") return norm(identity.identity_value) === name && Boolean(name);
    return false;
  });
}

async function answerSpecificClientSale(ops: any, role: string, person: string, client: any, question: string) {
  if (role === "DESIGN") {
    return { answer: "Essa informação fica fora do seu escopo de acesso. Posso consultar o que estiver dentro da sua área.", intent: "scope_restriction" };
  }
  if (role === "GT" && client.gt_owner !== person) {
    return { answer: "Esse cliente não está na sua carteira, então não posso abrir os dados comerciais dele por aqui.", intent: "scope_restriction" };
  }

  const [{ data: chats, error: chatError }, { data: reports, error: reportError }, { data: identities }] = await Promise.all([
    ops.from("whatsapp_chat_registry").select("chat_id,chat_name").eq("client_id", client.id).limit(100),
    ops.from("weekly_commercial_reports")
      .select("week_start,week_end,metrics,generated_at")
      .eq("client_id", client.id)
      .order("week_end", { ascending: false })
      .order("generated_at", { ascending: false })
      .limit(30),
    ops.from("whatsapp_team_identities").select("identity_type,identity_value").eq("active", true).limit(500),
  ]);
  if (chatError) throw new Error(`sale_chats:${chatError.message}`);
  if (reportError) throw new Error(`sale_reports:${reportError.message}`);

  const chatIds = (chats ?? []).map((row: any) => row.chat_id).filter(Boolean);
  let messages: any[] = [];
  if (chatIds.length) {
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const { data, error } = await ops.from("whatsapp_messages")
      .select("message_id,chat_id,chat_name,sender_name,sender_phone,event_at,text_body,caption")
      .in("chat_id", chatIds)
      .gte("event_at", since)
      .order("event_at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(`sale_messages:${error.message}`);
    messages = data ?? [];
  }

  const strong = messages
    .map((message: any) => ({
      ...message,
      body: String(message.text_body ?? message.caption ?? ""),
      normalized: norm(message.text_body ?? message.caption ?? ""),
      internal: senderIsInternal(message, identities ?? []),
    }))
    .filter((message: any) => STRONG_SALE.test(message.normalized))
    .sort((a: any, b: any) => Number(a.internal) - Number(b.internal) || new Date(b.event_at).getTime() - new Date(a.event_at).getTime());

  const latestReport = (reports ?? [])[0] ?? null;
  const reportedSales = Number(latestReport?.metrics?.sales || 0);
  const q = norm(question);
  const asksQuantity = QUANTITY_INTENT.test(q);

  if (strong.length) {
    const hit = strong[0];
    const evidence = `Em ${fmtDateTime(hit.event_at)}, ${hit.sender_name || "alguém do grupo"} escreveu no grupo ${hit.chat_name || "do cliente"}: “${clip(hit.body, 220)}”.`;
    if (asksQuantity) {
      if (reportedSales > 0) {
        const period = latestReport?.week_start && latestReport?.week_end ? `${fmtDate(latestReport.week_start)} a ${fmtDate(latestReport.week_end)}` : "no relatório mais recente";
        return {
          answer: `Sim. ${client.display_name} já tem venda confirmada. No relatório comercial de ${period}, foram registradas ${reportedSales} ${reportedSales === 1 ? "venda" : "vendas"}. Além disso, há confirmação explícita no WhatsApp: ${evidence}`,
          intent: "client_sale_evidence",
        };
      }
      return {
        answer: `Sim. ${client.display_name} já tem venda confirmada. ${evidence}\nEu consigo afirmar pelo menos uma venda, mas não vou transformar mensagens de comemoração em contagem total sem um relatório comercial estruturado.`,
        intent: "client_sale_evidence",
      };
    }
    return {
      answer: `Sim. ${client.display_name} já registrou venda. ${evidence}${hit.internal ? " É uma confirmação interna da equipe; não prova sozinha que a venda veio do tráfego." : " Essa é uma confirmação direta do próprio grupo do cliente; só não atribuo a venda ao tráfego se isso não estiver explícito na mensagem."}`,
      intent: "client_sale_evidence",
    };
  }

  if (reportedSales > 0) {
    const period = latestReport?.week_start && latestReport?.week_end ? `${fmtDate(latestReport.week_start)} a ${fmtDate(latestReport.week_end)}` : "no relatório mais recente";
    return {
      answer: `Sim. No relatório comercial de ${period}, ${client.display_name} registrou ${reportedSales} ${reportedSales === 1 ? "venda" : "vendas"}.`,
      intent: "client_sale_report",
    };
  }

  if (latestReport) {
    const period = latestReport?.week_start && latestReport?.week_end ? `${fmtDate(latestReport.week_start)} a ${fmtDate(latestReport.week_end)}` : "no relatório mais recente";
    return {
      answer: `No relatório comercial de ${period}, ${client.display_name} está com 0 vendas registradas, e eu não encontrei uma confirmação forte de venda nos grupos vinculados nos últimos 180 dias. Isso não prova que não vendeu; significa apenas que não há confirmação suficiente na base que consultei.`,
      intent: "client_sale_no_evidence",
    };
  }

  return {
    answer: `Não encontrei relatório comercial nem uma confirmação forte de venda nos grupos vinculados de ${client.display_name} nos últimos 180 dias. Então não vou dizer que vendeu nem que não vendeu sem evidência.`,
    intent: "client_sale_no_evidence",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "server_configuration" }, 500);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return json({ ok: false, error: "missing_question" }, 400);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const [{ data: pref }, { data: roster }, { data: clients }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("team_roster").select("person,role,access_level").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner").in("lifecycle", ["ACTIVE", "ONBOARDING", "CHURNED"]).order("display_name").limit(500),
  ]);

  const person = pref?.collaborator_person ?? null;
  const member = (roster ?? []).find((row: any) => row.person === person);
  if (!person || !member) return json({ ok: false, error: "OpsQuestion indisponível: colaborador não está ativo." }, 403);

  const role = String(member.role ?? "");
  const normalizedQuestion = norm(question);
  const client = resolveClient(question, clients ?? []);
  const specificSale = Boolean(client && SALE_INTENT.test(normalizedQuestion) && !RANKING_INTENT.test(normalizedQuestion));

  if (specificSale) {
    const started = Date.now();
    try {
      const result = await answerSpecificClientSale(ops, role, String(person), client, question);
      const latency = Date.now() - started;
      await ops.from("opsquestion_interactions").insert({
        user_key: user.id,
        person,
        role,
        access_level: String(member.access_level ?? "RESTRICTED"),
        question,
        status: "SUCCESS",
        source: "DIRECT_SALE_EVIDENCE",
        answer: result.answer.slice(0, 20000),
        request_id: crypto.randomUUID(),
        latency_ms: latency,
        answered_at: new Date().toISOString(),
      });
      return json({
        ok: true,
        name: "OpsQuestion",
        answer: result.answer,
        source: "Base operacional · evidência comercial",
        read_only: true,
        mode: "DIRECT_SALE_EVIDENCE",
        intent: result.intent,
        latency_ms: latency,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[opsquestion-sale-evidence]", error);
    }
  }

  const core = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask-team`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await core.text();
  return new Response(raw, {
    status: core.status,
    headers: { ...CORS, "content-type": core.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" },
  });
});
