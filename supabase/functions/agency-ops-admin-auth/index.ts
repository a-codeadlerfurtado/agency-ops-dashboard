import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("authorization") || "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return json({ ok: false, error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
  const requester = authData?.user;
  if (authError || !requester?.email) return json({ ok: false, error: "unauthorized" }, 401);

  const requesterEmail = requester.email.toLowerCase();
  const { data: loginIdentity } = await admin
    .schema("agency_ops")
    .from("team_login_emails")
    .select("person,email,active")
    .eq("email", requesterEmail)
    .eq("active", true)
    .maybeSingle();

  if (!loginIdentity?.person) return json({ ok: false, error: "forbidden" }, 403);

  const { data: rosterIdentity } = await admin
    .schema("agency_ops")
    .from("team_roster")
    .select("person,role,email")
    .eq("person", loginIdentity.person)
    .maybeSingle();

  if (loginIdentity.person !== "Adler Furtado" || rosterIdentity?.role !== "MGMT") {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  if (body?.action !== "RESET_PASSWORD") return json({ ok: false, error: "invalid_action" }, 400);
  const targetEmail = String(body?.target_email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!targetEmail || !targetEmail.includes("@")) return json({ ok: false, error: "invalid_target_email" }, 400);
  if (password.length < 10 || password.length > 128) return json({ ok: false, error: "invalid_password_length" }, 400);

  const { data: targetIdentity } = await admin
    .schema("agency_ops")
    .from("team_login_emails")
    .select("person,email,active")
    .eq("email", targetEmail)
    .eq("active", true)
    .maybeSingle();

  if (!targetIdentity?.person) return json({ ok: false, error: "target_not_in_team" }, 404);

  let targetUser: any = null;
  for (let page = 1; page <= 10 && !targetUser; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) return json({ ok: false, error: "auth_list_failed" }, 500);
    targetUser = data.users.find((u) => String(u.email || "").toLowerCase() === targetEmail) || null;
    if (data.users.length < 100) break;
  }
  if (!targetUser) return json({ ok: false, error: "auth_user_not_found" }, 404);

  const { error: updateError } = await admin.auth.admin.updateUserById(targetUser.id, { password });
  if (updateError) return json({ ok: false, error: "password_update_failed", detail: updateError.message }, 500);

  await admin.schema("agency_ops").from("audit_events").insert({
    actor: loginIdentity.person,
    action: "TEAM_PASSWORD_RESET",
    entity: "auth_user",
    entity_id: String(targetUser.id),
    before: { email: targetEmail, person: targetIdentity.person },
    after: { email: targetEmail, person: targetIdentity.person, password_changed: true },
  });

  return json({ ok: true, target_email: targetEmail, target_person: targetIdentity.person });
});
