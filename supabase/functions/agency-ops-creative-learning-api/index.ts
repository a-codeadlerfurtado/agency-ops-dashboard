import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const EDIT_PEOPLE = new Set(["Adler Furtado", "Joel Antoniete", "Gustavo Lima"]);
const RULE_KINDS = new Set(["DESEJA", "EVITAR", "COMO_APLICAR", "IDENTIDADE", "PROCESSO", "DADO_TECNICO"]);
const PROFILE_KEYS = ["audience", "product_focus", "objectives", "region", "client_type", "bottlenecks", "risks", "commercial_conditions"] as const;

type Json = Record<string, any>;

function objectValue(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function cleanText(value: unknown, max = 5000): string {
  return String(value ?? "").trim().slice(0, max);
}

function cleanTextArray(value: unknown, maxItems = 20): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\n,;]+/);
  return [...new Set(list.map((item) => cleanText(item, 180)).filter(Boolean))].slice(0, maxItems);
}

function cleanAssets(value: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = objectValue(item);
    const url = cleanText(row.url, 1200);
    if (!/^https?:\/\//i.test(url)) return [];
    return [{ label: cleanText(row.label || row.name || "Arquivo", 120) || "Arquivo", url }];
  }).slice(0, 30);
}

async function audit(ops: any, person: string, action: string, clientId: string, before: unknown, after: unknown) {
  await ops.from("audit_events").insert({
    actor: person,
    action,
    entity: "creative_manual_control",
    entity_id: clientId,
    before: before ?? null,
    after: after ?? null,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ error: "server_configuration" }, 500);
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: decisions }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userData.user.id).eq("status", "APPROVED"),
  ]);
  if (!(decisions ?? []).some((row: any) => row.kind === "SIGNUP")) return respond({ error: "forbidden" }, 403);

  const person = pref?.collaborator_person ?? null;
  if (!person) return respond({ error: "collaborator_required" }, 403);
  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level,is_former")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return respond({ error: "forbidden" }, 403);

  const { data: allowedViews, error: allowedError } = await ops.rpc("dashboard_allowed_views", {
    p_person: roster.person,
    p_role: roster.role,
  });
  if (allowedError || !Array.isArray(allowedViews) || !allowedViews.includes("creative")) {
    return respond({ error: "forbidden" }, 403);
  }

  const canEdit = roster.role === "DESIGN" || EDIT_PEOPLE.has(roster.person);

  if (req.method === "GET") {
    const [{ data: profiles, error: profileError }, { data: brands }, { data: edits }] = await Promise.all([
      ops.from("creative_learning_client_summary")
        .select("client_id,coverage_pct,conflict_count,learned_count,weak_signal_count,last_signal_at,evidence_count,evidence_sources,learned_items,questions,profile_status"),
      ops.from("creative_brand_profiles").select("client_id,metadata"),
      ops.from("audit_events")
        .select("id,actor,action,entity_id,before,after,created_at")
        .eq("entity", "creative_manual_control")
        .order("created_at", { ascending: false })
        .limit(150),
    ]);
    if (profileError) return respond({ error: "query_failed", detail: profileError.message }, 500);

    const rows = profiles ?? [];
    const manualProfiles = (brands ?? []).flatMap((row: any) => {
      const metadata = objectValue(row.metadata);
      const manual = objectValue(metadata.manual_profile);
      return Object.keys(manual).length ? [{ client_id: row.client_id, ...manual }] : [];
    });

    return respond({
      profiles: rows,
      summary: {
        total: rows.length,
        with_evidence: rows.filter((row: any) => Number(row.evidence_count || 0) > 0).length,
        complete: rows.filter((row: any) => row.profile_status === "COMPLETE").length,
        learning: rows.filter((row: any) => row.profile_status === "LEARNING").length,
        conflict: rows.filter((row: any) => row.profile_status === "CONFLICT").length,
        needs_confirmation: rows.filter((row: any) => row.profile_status === "NEEDS_CONFIRMATION").length,
      },
      manual_profiles: manualProfiles,
      manual_edits: edits ?? [],
      editor: { person: roster.person, role: roster.role, can_edit: canEdit },
      generated_at: new Date().toISOString(),
    });
  }

  if (!canEdit) return respond({ error: "editing_forbidden" }, 403);

  let body: Json = {};
  try {
    body = objectValue(await req.json());
  } catch {
    return respond({ error: "invalid_json" }, 400);
  }

  const action = cleanText(body.action, 80);
  const clientId = cleanText(body.client_id, 80);
  if (!clientId) return respond({ error: "client_id_required" }, 400);

  const { data: client } = await ops.from("clients")
    .select("id,display_name,lifecycle")
    .eq("id", clientId)
    .in("lifecycle", ["ACTIVE", "ONBOARDING"])
    .maybeSingle();
  if (!client) return respond({ error: "client_not_found" }, 404);

  const now = new Date().toISOString();

  if (action === "save_manual_profile") {
    const { data: currentBrand } = await ops.from("creative_brand_profiles")
      .select("metadata")
      .eq("client_id", clientId)
      .maybeSingle();
    const metadata = objectValue(currentBrand?.metadata);
    const before = objectValue(metadata.manual_profile);
    const supplied = objectValue(body.profile);
    const next: Json = {};
    for (const key of PROFILE_KEYS) next[key] = cleanText(supplied[key], 5000);
    next.updated_by = roster.person;
    next.updated_at = now;

    const nextMetadata = { ...metadata, manual_profile: next };
    const { error } = await ops.from("creative_brand_profiles").upsert({
      client_id: clientId,
      metadata: nextMetadata,
      updated_at: now,
    }, { onConflict: "client_id" });
    if (error) return respond({ error: "save_failed", detail: error.message }, 500);
    await audit(ops, roster.person, "CREATIVE_MANUAL_PROFILE_SAVE", clientId, before, next);
    return respond({ ok: true, action, client_id: clientId, profile: next });
  }

  if (action === "save_brand") {
    const { data: currentBrand } = await ops.from("creative_brand_profiles")
      .select("color_palette,fonts,logo_rules,visual_direction,asset_links,status,source_type,source_ref,metadata")
      .eq("client_id", clientId)
      .maybeSingle();
    const metadata = objectValue(currentBrand?.metadata);
    const before = currentBrand ?? null;
    const next = {
      client_id: clientId,
      color_palette: cleanTextArray(body.color_palette),
      fonts: cleanTextArray(body.fonts),
      logo_rules: cleanText(body.logo_rules, 5000) || null,
      visual_direction: cleanText(body.visual_direction, 5000) || null,
      asset_links: cleanAssets(body.asset_links),
      status: "CONFIRMED",
      source_type: "MANUAL_DASHBOARD",
      source_ref: roster.person,
      last_verified_at: now,
      metadata: {
        ...metadata,
        manual_brand_control: { updated_by: roster.person, updated_at: now },
      },
      updated_at: now,
    };
    const { error } = await ops.from("creative_brand_profiles").upsert(next, { onConflict: "client_id" });
    if (error) return respond({ error: "save_failed", detail: error.message }, 500);
    await audit(ops, roster.person, "CREATIVE_BRAND_SAVE", clientId, before, next);
    return respond({ ok: true, action, client_id: clientId });
  }

  if (action === "save_rule") {
    const ruleId = cleanText(body.rule_id, 80) || null;
    const ruleKind = cleanText(body.rule_kind, 40).toUpperCase();
    const ruleText = cleanText(body.rule_text, 5000);
    const productScope = cleanText(body.product_scope, 300) || null;
    if (!RULE_KINDS.has(ruleKind)) return respond({ error: "invalid_rule_kind" }, 400);
    if (!ruleText) return respond({ error: "rule_text_required" }, 400);

    if (ruleId) {
      const { data: currentRule } = await ops.from("creative_client_rules")
        .select("*")
        .eq("id", ruleId)
        .eq("client_id", clientId)
        .maybeSingle();
      if (!currentRule) return respond({ error: "rule_not_found" }, 404);
      const currentMetadata = objectValue(currentRule.metadata);
      const nextMetadata = {
        ...currentMetadata,
        original_source: currentMetadata.original_source ?? {
          source_type: currentRule.source_type,
          source_ref: currentRule.source_ref,
          observed_at: currentRule.observed_at,
        },
        last_manual_edit: { updated_by: roster.person, updated_at: now },
      };
      const patch = {
        classification: productScope ? "POR_PRODUTO" : "REGRA_FIXA",
        rule_kind: ruleKind,
        rule_text: ruleText,
        product_scope: productScope,
        status: "CONFIRMED",
        confidence: 1,
        source_type: "MANUAL_DASHBOARD",
        source_ref: roster.person,
        last_confirmed_at: now,
        metadata: nextMetadata,
        updated_at: now,
      };
      const { error } = await ops.from("creative_client_rules").update(patch).eq("id", ruleId).eq("client_id", clientId);
      if (error) return respond({ error: "save_failed", detail: error.message }, 500);
      await audit(ops, roster.person, "CREATIVE_RULE_UPDATE", clientId, currentRule, { id: ruleId, ...patch });
      return respond({ ok: true, action, client_id: clientId, rule_id: ruleId });
    }

    const insert = {
      client_id: clientId,
      classification: productScope ? "POR_PRODUTO" : "REGRA_FIXA",
      rule_kind: ruleKind,
      rule_text: ruleText,
      product_scope: productScope,
      status: "CONFIRMED",
      confidence: 1,
      source_type: "MANUAL_DASHBOARD",
      source_ref: roster.person,
      observed_at: now,
      last_confirmed_at: now,
      metadata: { manual_created_by: roster.person, manual_created_at: now },
      updated_at: now,
    };
    const { data: created, error } = await ops.from("creative_client_rules").insert(insert).select("id").single();
    if (error) return respond({ error: "save_failed", detail: error.message }, 500);
    await audit(ops, roster.person, "CREATIVE_RULE_CREATE", clientId, null, { id: created.id, ...insert });
    return respond({ ok: true, action, client_id: clientId, rule_id: created.id });
  }

  if (action === "archive_rule") {
    const ruleId = cleanText(body.rule_id, 80);
    if (!ruleId) return respond({ error: "rule_id_required" }, 400);
    const { data: currentRule } = await ops.from("creative_client_rules")
      .select("*")
      .eq("id", ruleId)
      .eq("client_id", clientId)
      .maybeSingle();
    if (!currentRule) return respond({ error: "rule_not_found" }, 404);
    const metadata = {
      ...objectValue(currentRule.metadata),
      manual_archived_by: roster.person,
      manual_archived_at: now,
    };
    const patch = { status: "SUPERSEDED", metadata, updated_at: now };
    const { error } = await ops.from("creative_client_rules").update(patch).eq("id", ruleId).eq("client_id", clientId);
    if (error) return respond({ error: "save_failed", detail: error.message }, 500);
    await audit(ops, roster.person, "CREATIVE_RULE_ARCHIVE", clientId, currentRule, { ...currentRule, ...patch });
    return respond({ ok: true, action, client_id: clientId, rule_id: ruleId });
  }

  return respond({ error: "unknown_action" }, 400);
});
