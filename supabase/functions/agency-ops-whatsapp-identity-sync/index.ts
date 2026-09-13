import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Instance = { instanceId: string; token: string; clientToken: string; key: string };
type Identity = { key: string; phone: string | null; lid: string | null; providerPhone: string | null };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ZAPI_BASE = "https://api.z-api.io";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (value: unknown, max = 300) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
const phone = (value: unknown) => {
  const v = digits(value);
  return v.length >= 10 && v.length <= 15 ? v : null;
};
const lid = (value: unknown) => {
  const v = digits(value);
  return v.length >= 8 && v.length <= 22 ? v : null;
};
const phoneFromJid = (value: unknown) => {
  const raw = clean(value, 220).toLowerCase();
  if (!raw) return null;
  if (raw.endsWith("@c.us") || raw.endsWith("@s.whatsapp.net")) return phone(raw.split("@")[0]);
  return null;
};
const lidFromJid = (value: unknown) => {
  const raw = clean(value, 220).toLowerCase();
  return raw.endsWith("@lid") ? lid(raw.split("@")[0]) : null;
};
function participantIdentity(row: Row): Identity | null {
  const jid = row.id ?? row.jid;
  const providerPhone = phone(row.phone ?? row.number ?? row.phoneNumber ?? row.phone_number);
  const explicitLid = lid(row.lid ?? row.senderLid ?? row.sender_lid);
  const jidLid = lidFromJid(jid);
  if (jidLid) return { key: `lid:${jidLid}`, phone: null, lid: jidLid, providerPhone };
  if (explicitLid && providerPhone && explicitLid === providerPhone) {
    return { key: `lid:${explicitLid}`, phone: null, lid: explicitLid, providerPhone };
  }
  const p = providerPhone || phoneFromJid(jid);
  if (p) return { key: `phone:${p}`, phone: p, lid: explicitLid, providerPhone };
  if (explicitLid) return { key: `lid:${explicitLid}`, phone: null, lid: explicitLid, providerPhone };
  return null;
}
const groupId = (value: unknown) => {
  const raw = clean(value, 220);
  if (!raw) return null;
  if (raw.endsWith("@g.us")) return `${raw.slice(0, -5)}-group`;
  return raw.includes("-group") ? raw : null;
};
const norm = (value: unknown) => clean(value, 300).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const groupBase = (value: unknown) => norm(String(value ?? "").replace(/^\s*\[[^\]]+\]\s*/i, ""));

async function authorized(req: Request, ops: any) {
  const token = req.headers.get("x-automation-secret") || "";
  if (token.length < 32) return false;
  const { data, error } = await ops.from("whatsapp_identity_sync_runtime").select("request_token").eq("singleton", true).maybeSingle();
  if (error) throw error;
  const expected = String(data?.request_token || "");
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function rowsFrom(payload: any, keys: string[]) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}
async function instances(ops: any): Promise<Instance[]> {
  const { data, error } = await ops.rpc("view_oncall_zapi_credentials");
  if (error) throw error;
  const instanceId = clean(data?.instance_id, 120), token = clean(data?.instance_token, 600), clientToken = clean(data?.client_token, 600);
  if (!instanceId || !token || !clientToken) throw new Error("zapi_configuration_missing");
  return [{ instanceId, token, clientToken, key: "primary" }];
}
async function zapiJson(instance: Instance, path: string) {
  const res = await fetch(`${ZAPI_BASE}/instances/${instance.instanceId}/token/${instance.token}/${path}`, {
    headers: { "Client-Token": instance.clientToken, accept: "application/json" },
  });
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 800) }; }
  if (!res.ok) throw new Error(`zapi_${res.status}:${JSON.stringify(payload).slice(0, 600)}`);
  return payload;
}
async function contactMap(instance: Instance) {
  const map = new Map<string, Row>();
  const pageSize = 100;
  for (let page = 1; page <= 100; page++) {
    const payload = await zapiJson(instance, `contacts?page=${page}&pageSize=${pageSize}`);
    const rows = rowsFrom(payload, ["contacts", "data", "items"]);
    for (const row of rows) {
      const p = phone(row.phone ?? row.number ?? row.phoneNumber ?? row.phone_number) || phoneFromJid(row.id ?? row.jid);
      if (p) map.set(p, row);
    }
    if (!rows.length || rows.length < pageSize) break;
  }
  return map;
}
function bestName(participant: Row, contact?: Row | null) {
  return clean(participant.name || participant.notify || participant.vname || participant.short
    || contact?.name || contact?.notify || contact?.vname || contact?.short, 160) || null;
}
async function groupClient(ops: any, chatId: string, subject: string) {
  const { data: reg } = await ops.from("whatsapp_chat_registry").select("client_id,reason").eq("chat_id", chatId).maybeSingle();
  if (reg?.client_id) return String(reg.client_id);
  const { data: integ } = await ops.from("client_integrations").select("client_id").eq("system", "WHATSAPP_GROUP").eq("external_id", chatId).limit(2);
  if (integ?.length === 1) return String(integ[0].client_id);
  const { data: state } = await ops.from("conversation_state").select("client_id").eq("chat_id", chatId).maybeSingle();
  if (state?.client_id) return String(state.client_id);
  const { data: jobs } = await ops.from("onboarding_group_jobs").select("client_id").eq("zapi_group_id", chatId)
    .not("client_id", "is", null).order("updated_at", { ascending: false }).limit(2);
  if (jobs?.length === 1) return String(jobs[0].client_id);
  const base = groupBase(subject);
  if (!base) return null;
  const { data: clients } = await ops.from("clients").select("id,display_name,normalized_name").in("lifecycle", ["ACTIVE", "ONBOARDING"]);
  const exact = (clients || []).filter((row: Row) => [row.display_name, row.normalized_name].map(norm).filter(Boolean).includes(base));
  return exact.length === 1 ? String(exact[0].id) : null;
}
async function teamMap(ops: any) {
  const { data, error } = await ops.from("whatsapp_team_identities")
    .select("identity_value,canonical_name,role,active,updated_at").eq("identity_type", "PHONE")
    .order("active", { ascending: false }).order("updated_at", { ascending: false });
  if (error) throw error;
  const out = new Map<string, Row>();
  for (const row of data || []) {
    const p = phone(row.identity_value);
    if (p && !out.has(p)) out.set(p, row);
  }
  return out;
}
async function roleMapForClient(ops: any, clientId: string | null) {
  const out = new Map<string, Row>();
  if (!clientId) return out;
  const { data: jobs } = await ops.from("onboarding_group_jobs").select("id").eq("client_id", clientId)
    .order("updated_at", { ascending: false }).limit(20);
  const ids = (jobs || []).map((r: Row) => r.id).filter(Boolean);
  if (!ids.length) return out;
  const { data } = await ops.from("onboarding_group_participants")
    .select("phone_e164,name,role,participant_type,created_at").in("job_id", ids).order("created_at", { ascending: false });
  for (const row of data || []) {
    const p = phone(row.phone_e164);
    if (p && !out.has(p)) out.set(p, row);
  }
  return out;
}

async function syncGroupOnInstance(ops: any, instance: Instance, chatId: string, contacts?: Map<string, Row>) {
  const meta = await zapiJson(instance, `light-group-metadata/${encodeURIComponent(chatId)}`);
  const subject = clean(meta?.subject || meta?.name || meta?.groupName, 300) || chatId;
  const participants = rowsFrom(meta, ["participants", "members", "data"]);
  const clientId = await groupClient(ops, chatId, subject);
  const now = new Date().toISOString();

  const { data: existingChat } = await ops.from("whatsapp_chat_registry")
    .select("chat_id,reason,scope,client_id,first_seen_at,message_count").eq("chat_id", chatId).maybeSingle();
  if (!String(existingChat?.reason || "").startsWith("MANUAL:")) {
    await ops.from("whatsapp_chat_registry").upsert({
      chat_id: chatId, chat_name: subject, scope: clientId ? "CLIENT" : (existingChat?.scope === "INTERNAL" || existingChat?.scope === "TEST" ? existingChat.scope : "UNKNOWN"),
      client_id: clientId, confidence: clientId ? "CONFIRMED" : "LOW",
      reason: clientId ? "zapi_group_snapshot_client_link" : "zapi_group_snapshot_unresolved",
      first_seen_at: existingChat?.first_seen_at || now, last_seen_at: now,
      message_count: Number(existingChat?.message_count || 0), updated_at: now,
    }, { onConflict: "chat_id" });
  }

  const teams = await teamMap(ops);
  const roles = await roleMapForClient(ops, clientId);
  const { data: existingRows, error: existingError } = await ops.from("whatsapp_participant_identity")
    .select("id,identity_key,phone,sender_lid,canonical_name,role_hint,client_id,side,confidence,source,first_seen_at,metadata").eq("chat_id", chatId);
  if (existingError) throw existingError;
  const existing = new Map((existingRows || []).map((r: Row) => [String(r.identity_key), r]));
  const { data: registryRows } = clientId ? await ops.from("client_phone_registry")
    .select("id,phone,first_seen_at,evidence_count").eq("client_id", clientId).eq("chat_id", chatId) : { data: [] };
  const existingRegistry = new Map((registryRows || []).map((r: Row) => [phone(r.phone), r]).filter(([p]: any) => !!p));

  const identityRows: Row[] = [];
  const clientRows: Row[] = [];
  let names = 0;
  for (const participant of participants) {
    const ident = participantIdentity(participant);
    if (!ident) continue;
    const old = existing.get(ident.key) || {};
    const aliasPhone = ident.phone || (ident.lid && ident.providerPhone === ident.lid ? ident.providerPhone : null);
    const team = aliasPhone ? (teams.get(aliasPhone) || null) : null;
    const knownRole = ident.phone ? (roles.get(ident.phone) || null) : null;
    const providerName = bestName(participant, ident.phone ? contacts?.get(ident.phone) : null);
    const isManual = String(old.source || "").toUpperCase().startsWith("RELATO_MANUAL");
    const canonicalName = team?.canonical_name || knownRole?.name || old.canonical_name || providerName || null;
    const role = team?.role || knownRole?.role || old.role_hint || ((participant.isAdmin || participant.isSuperAdmin) ? "GROUP_ADMIN" : clientId ? "CLIENT_CONTACT" : null);
    const side = team ? "TEAM" : clientId ? "CLIENT_SIDE" : "EXTERNAL";
    if (canonicalName) names++;
    identityRows.push({
      chat_id: chatId, identity_key: ident.key, phone: ident.phone, sender_lid: ident.lid,
      canonical_name: isManual ? old.canonical_name : canonicalName,
      client_id: isManual ? old.client_id : (team ? null : clientId),
      side: isManual ? old.side : side,
      role_hint: isManual ? old.role_hint : role,
      confidence: isManual ? old.confidence : team ? 1 : clientId ? 0.98 : providerName ? 0.8 : 0.6,
      source: isManual ? old.source : "ZAPI_GROUP_SNAPSHOT",
      first_seen_at: old.first_seen_at || now, last_seen_at: now,
      metadata: { ...(old.metadata || {}), whatsapp_name: providerName, group_subject: subject,
        is_admin: Boolean(participant.isAdmin), is_super_admin: Boolean(participant.isSuperAdmin),
        group_creator: (ident.phone && phone(meta?.owner) === ident.phone) || (ident.lid && lidFromJid(meta?.owner) === ident.lid),
        active_in_group: true, zapi_instance_key: instance.key, snapshot_at: now,
        identity_kind: ident.phone ? "PHONE" : "LID", not_a_phone: !ident.phone,
        provider_phone_value: ident.providerPhone,
        historical_team_identity: Boolean(team && team.active === false) },
      updated_at: now,
    });
    if (clientId && ident.phone && !team) {
      const oldReg = existingRegistry.get(ident.phone) || {};
      clientRows.push({
        client_id: clientId, phone: ident.phone, chat_id: chatId,
        first_seen_at: oldReg.first_seen_at || now, last_seen_at: now,
        evidence_count: Math.max(1, Number(oldReg.evidence_count || 1)), source: "zapi_group_snapshot", active: true, updated_at: now,
      });
    }
  }
  if (identityRows.length) {
    const { error } = await ops.from("whatsapp_participant_identity").upsert(identityRows, { onConflict: "chat_id,identity_key" });
    if (error) throw error;
  }
  if (clientRows.length) {
    const { error } = await ops.from("client_phone_registry").upsert(clientRows, { onConflict: "client_id,phone,chat_id" });
    if (error) throw error;
  }

  const currentKeys = new Set(identityRows.map((r) => String(r.identity_key)));
  const currentPhones = new Set(identityRows.map((r) => r.phone ? String(r.phone) : null).filter(Boolean));
  const staleIdentityIds = (existingRows || [])
    .filter((r: Row) => r.id && !currentKeys.has(String(r.identity_key)) && !String(r.source || "").toUpperCase().startsWith("RELATO_MANUAL"))
    .map((r: Row) => r.id);
  for (const id of staleIdentityIds) {
    const old = (existingRows || []).find((r: Row) => r.id === id) || {};
    const { error } = await ops.from("whatsapp_participant_identity").update({
      confidence: Math.min(Number(old.confidence || 0.5), 0.4),
      metadata: { ...(old.metadata || {}), active_in_group: false, left_detected_at: now }, updated_at: now,
    }).eq("id", id);
    if (error) throw error;
  }
  if (clientId) {
    const staleRegistryIds = (registryRows || []).filter((r: Row) => {
      const p = phone(r.phone);
      return r.id && p && (!currentPhones.has(p) || teams.has(p));
    }).map((r: Row) => r.id);
    if (staleRegistryIds.length) {
      const { error } = await ops.from("client_phone_registry").update({ active: false, updated_at: now }).in("id", staleRegistryIds);
      if (error) throw error;
    }
  }

  const { data: auditRows, error: auditError } = await ops.from("whatsapp_participant_identity")
    .select("identity_key,metadata").eq("chat_id", chatId);
  if (auditError) throw auditError;
  const activeDbKeys = new Set((auditRows || []).filter((r: Row) => r.metadata?.active_in_group === true).map((r: Row) => String(r.identity_key)));
  const missing = [...currentKeys].filter((key) => !activeDbKeys.has(key));
  const extra = [...activeDbKeys].filter((key) => !currentKeys.has(key));
  const { error: stateError } = await ops.from("whatsapp_group_identity_sync_state").upsert({
    chat_id: chatId, instance_id: instance.instanceId, subject, client_id: clientId,
    provider_participant_count: currentKeys.size, db_participant_count: activeDbKeys.size,
    named_count: names, unresolved_count: identityRows.filter((r) => !r.canonical_name).length,
    last_synced_at: now, last_error: null,
    metadata: { owner: clean(meta?.owner, 220) || null, missing_count: missing.length, extra_count: extra.length,
      audit_match: missing.length === 0 && extra.length === 0 }, updated_at: now,
  }, { onConflict: "chat_id" });
  if (stateError) throw stateError;
  return { chat_id: chatId, subject, client_id: clientId, provider: currentKeys.size, stored: activeDbKeys.size,
    named: names, unresolved: identityRows.filter((r) => !r.canonical_name).length, audit_match: missing.length === 0 && extra.length === 0 };
}

async function syncGroup(ops: any, chatId: string, preferredInstance?: string | null, contacts?: Map<string, Row>) {
  const all = await instances(ops);
  const ordered = preferredInstance ? [...all.filter((i) => i.instanceId === preferredInstance), ...all.filter((i) => i.instanceId !== preferredInstance)] : all;
  let last: unknown = null;
  for (const instance of ordered) {
    try { return await syncGroupOnInstance(ops, instance, chatId, contacts); } catch (error) { last = error; }
  }
  const message = last instanceof Error ? last.message : "group_not_found_on_enabled_instances";
  await ops.from("whatsapp_group_identity_sync_state").upsert({ chat_id: chatId, last_error: message.slice(0, 1000), updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
  throw new Error(message);
}
async function syncContact(ops: any, value: unknown) {
  const p = phone(value);
  if (!p) throw new Error("invalid_phone");
  const all = await instances(ops);
  let detail: Row | null = null, used: Instance | null = null;
  for (const instance of all) {
    try { detail = await zapiJson(instance, `contacts/${p}`); used = instance; break; } catch { /* next */ }
  }
  if (!detail) throw new Error("contact_not_found_on_enabled_instances");
  const providerName = bestName(detail, detail);
  const teams = await teamMap(ops);
  const team = teams.get(p) || null;
  const { data: rows } = await ops.from("whatsapp_participant_identity")
    .select("id,canonical_name,role_hint,source,metadata,client_id,side").eq("phone", p);
  for (const row of rows || []) {
    const manual = String(row.source || "").toUpperCase().startsWith("RELATO_MANUAL");
    const patch: Row = {
      canonical_name: manual ? row.canonical_name : (team?.canonical_name || row.canonical_name || providerName),
      role_hint: manual ? row.role_hint : (team?.role || row.role_hint),
      client_id: manual ? row.client_id : (team ? null : row.client_id),
      side: manual ? row.side : (team ? "TEAM" : row.side),
      metadata: { ...(row.metadata || {}), whatsapp_name: providerName, contact_synced_at: new Date().toISOString(), zapi_instance_key: used?.key,
        historical_team_identity: Boolean(team && team.active === false) }, updated_at: new Date().toISOString(),
    };
    if (team) patch.confidence = 1;
    const { error } = await ops.from("whatsapp_participant_identity").update(patch).eq("id", row.id);
    if (error) throw error;
  }
  if (team) await ops.from("client_phone_registry").update({ active: false, updated_at: new Date().toISOString() }).eq("phone", p).eq("active", true);
  await ops.from("whatsapp_contact_identity_sync_state").upsert({
    phone: p, whatsapp_name: providerName, last_synced_at: new Date().toISOString(), last_error: null,
    metadata: { notify: clean(detail.notify, 160) || null, short: clean(detail.short, 160) || null }, updated_at: new Date().toISOString(),
  }, { onConflict: "phone" });
  return { phone: p, name: providerName, rows_updated: (rows || []).length, team_identity: Boolean(team) };
}
async function listGroups(instance: Instance) {
  const out: Row[] = [], pageSize = 100;
  for (let page = 1; page <= 20; page++) {
    const payload = await zapiJson(instance, `groups?page=${page}&pageSize=${pageSize}`);
    const rows = rowsFrom(payload, ["groups", "data", "items"]);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
async function syncAll(ops: any) {
  const enabled = await instances(ops), results: Row[] = [], errors: Row[] = [];
  let providerGroups = 0;
  for (const instance of enabled) {
    let contacts = new Map<string, Row>();
    try { contacts = await contactMap(instance); } catch (error) { errors.push({ instance: instance.key, stage: "contacts", error: error instanceof Error ? error.message : String(error) }); }
    let groups: Row[] = [];
    try { groups = await listGroups(instance); } catch (error) { errors.push({ instance: instance.key, stage: "groups", error: error instanceof Error ? error.message : String(error) }); continue; }
    const unique = new Map<string, Row>();
    for (const row of groups) { const id = groupId(row.phone || row.id || row.groupId); if (id) unique.set(id, row); }
    providerGroups += unique.size;
    const batch = [...unique.keys()];
    for (let offset = 0; offset < batch.length; offset += 6) {
      await Promise.all(batch.slice(offset, offset + 6).map(async (id) => {
        try { results.push(await syncGroupOnInstance(ops, instance, id, contacts)); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ instance: instance.key, chat_id: id, stage: "metadata", error: message });
          await ops.from("whatsapp_group_identity_sync_state").upsert({ chat_id: id, instance_id: instance.instanceId, last_error: message.slice(0, 1000), updated_at: new Date().toISOString() }, { onConflict: "chat_id" });
        }
      }));
    }
  }
  const providerParticipants = results.reduce((n, r) => n + Number(r.provider || 0), 0);
  const storedParticipants = results.reduce((n, r) => n + Number(r.stored || 0), 0);
  const unresolved = results.reduce((n, r) => n + Number(r.unresolved || 0), 0);
  const mismatchedGroups = results.filter((r) => r.audit_match !== true).length;
  return { enabled_instances: enabled.length, provider_groups: providerGroups, synced_groups: results.length,
    failed_groups: errors.filter((r) => r.chat_id).length, provider_participants: providerParticipants,
    stored_participants: storedParticipants, unresolved_names: unresolved, mismatched_groups: mismatchedGroups,
    audit_ok: errors.filter((r) => r.chat_id).length === 0 && mismatchedGroups === 0, errors: errors.slice(0, 50) };
}
async function syncBatch(ops: any, requestedLimit: unknown) {
  const enabled = await instances(ops), instance = enabled[0];
  if (!instance) throw new Error("zapi_instance_missing");
  const groups = await listGroups(instance), unique = new Map<string, Row>();
  for (const row of groups) { const id = groupId(row.phone || row.id || row.groupId); if (id) unique.set(id, row); }
  const { data: states, error } = await ops.from("whatsapp_group_identity_sync_state").select("chat_id,last_error,last_synced_at,metadata");
  if (error) throw error;
  const stateMap = new Map((states || []).map((r: Row) => [String(r.chat_id), r]));
  const ids = [...unique.keys()].sort((a, b) => {
    const ra = stateMap.get(a), rb = stateMap.get(b);
    const badA = !ra || ra.last_error || ra.metadata?.audit_match !== true ? 0 : 1;
    const badB = !rb || rb.last_error || rb.metadata?.audit_match !== true ? 0 : 1;
    if (badA !== badB) return badA - badB;
    return Date.parse(String(ra?.last_synced_at || 0)) - Date.parse(String(rb?.last_synced_at || 0));
  });
  const limit = Math.max(1, Math.min(Number(requestedLimit || 20), 20));
  const selected = ids.slice(0, limit), results: Row[] = [], errors: Row[] = [];
  for (const id of selected) {
    try { results.push(await syncGroupOnInstance(ops, instance, id)); }
    catch (error) { errors.push({ chat_id: id, error: error instanceof Error ? error.message : String(error) }); }
    await new Promise((r) => setTimeout(r, 250));
  }
  const { data: after } = await ops.from("whatsapp_group_identity_sync_state").select("chat_id,last_error,metadata");
  const audited = new Set((after || []).filter((r: Row) => !r.last_error && r.metadata?.audit_match === true).map((r: Row) => String(r.chat_id)));
  const remaining = ids.filter((id) => !audited.has(id));
  return { provider_groups: unique.size, attempted: selected.length, synced_groups: results.length, failed_groups: errors.length,
    audited_groups: ids.filter((id) => audited.has(id)).length, remaining_groups: remaining.length, audit_ok: remaining.length === 0, errors: errors.slice(0, 20) };
}
async function enrichNames(ops: any) {
  const enabled = await instances(ops), instance = enabled[0];
  if (!instance) throw new Error("zapi_instance_missing");
  const contacts = await contactMap(instance);
  const { data: rows, error } = await ops.from("whatsapp_participant_identity").select("id,phone,canonical_name,source,metadata").is("canonical_name", null);
  if (error) throw error;
  let updated = 0;
  for (const row of rows || []) {
    const p = phone(row.phone); if (!p) continue;
    const contact = contacts.get(p); if (!contact) continue;
    const name = bestName(contact, contact); if (!name) continue;
    const { error: updateError } = await ops.from("whatsapp_participant_identity").update({
      canonical_name: name, metadata: { ...(row.metadata || {}), whatsapp_name: name, contact_enriched_at: new Date().toISOString() }, updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (!updateError) updated++;
  }
  const { data: left } = await ops.from("whatsapp_participant_identity").select("phone").is("canonical_name", null);
  return { contacts_loaded: contacts.size, candidate_rows: (rows || []).length, updated, remaining_rows: (left || []).length };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE) return reply({ error: "server_configuration" }, 500);
  const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  try { if (!(await authorized(req, ops))) return reply({ error: "unauthorized" }, 401); }
  catch (error) { return reply({ error: "auth_failed", detail: error instanceof Error ? error.message : String(error) }, 500); }
  let body: Row = {};
  try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); }
  const action = clean(body.action, 50).toLowerCase();
  try {
    if (action === "sync_group") {
      const id = groupId(body.chat_id || body.group_id);
      if (!id) return reply({ error: "group_id_required" }, 400);
      return reply({ ok: true, result: await syncGroup(ops, id, clean(body.instance_id, 120) || null) });
    }
    if (action === "sync_contact") {
      const p = phone(body.phone); if (!p) return reply({ error: "phone_required" }, 400);
      return reply({ ok: true, result: await syncContact(ops, p) });
    }
    if (action === "enrich_names") return reply({ ok: true, result: await enrichNames(ops) });
    if (action === "sync_batch") {
      const result = await syncBatch(ops, body.limit);
      return reply({ ok: result.audit_ok, ...result }, result.audit_ok ? 200 : 207);
    }
    if (action === "sync_all" || action === "audit") {
      const result = await syncAll(ops);
      return reply({ ok: result.audit_ok, ...result }, result.audit_ok ? 200 : 207);
    }
    return reply({ error: "unknown_action" }, 400);
  } catch (error) {
    return reply({ error: "identity_sync_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
