import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clip = (value: unknown, max = 7000) => String(value ?? "").trim().slice(0, max) || null;
const csvEscape = (value: unknown) => { const t = value == null ? "" : String(value); return /[",\n]/.test(t) ? `"${t.replaceAll('"','""')}"` : t; };
const csv = (rows: unknown[][], filename: string) => new Response("\ufeff" + rows.map(r => r.map(csvEscape).join(",")).join("\r\n"), { headers: { ...CORS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
const requiredText = (row: Row, key: string) => Boolean(String(row?.[key] || "").trim());

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData?.user?.id) return json({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = authData.user.id;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = String(pref?.collaborator_person || "").trim();
  const { data: roster } = person ? await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle() : { data: null } as any;
  const role = String(roster?.role || "");
  const isAdler = person === "Adler Furtado";
  if (!isAdler && role !== "GT") return json({ error: "not_found" }, 404);

  async function runs() {
    const { data, error } = await ops.from("meta_performance_runs").select("*").in("status", ["COMPLETED","COMPLETED_WITH_ERRORS"]).order("snapshot_date", { ascending: false }).limit(52);
    if (error) throw error;
    return data || [];
  }
  async function targetContext(runIdRaw: string | null, gtRaw: string | null) {
    const allRuns = await runs();
    const run = runIdRaw ? allRuns.find((r: Row) => String(r.id) === runIdRaw) : allRuns[0];
    if (!run) throw new Error("run_not_found");
    const gt = isAdler ? String(gtRaw || "").trim() : person;
    if (!isAdler && gt !== person) throw new Error("forbidden");
    return { allRuns, run, gt };
  }
  async function loadGt(runId: string, gt: string) {
    const [snapRes, analysisRes, submissionRes] = await Promise.all([
      ops.from("meta_performance_snapshots").select("*").eq("run_id", runId).eq("gt_owner", gt).order("client_name", { ascending: true }).order("period_days", { ascending: true }).limit(1000),
      ops.from("meta_gt_client_analyses").select("*").eq("run_id", runId).eq("gt_person", gt).limit(1000),
      ops.from("meta_gt_weekly_submissions").select("*").eq("run_id", runId).eq("gt_person", gt).maybeSingle(),
    ]);
    if (snapRes.error) throw snapRes.error;
    if (analysisRes.error) throw analysisRes.error;
    if (submissionRes.error) throw submissionRes.error;
    const byClient = new Map<string, Row>();
    for (const s of snapRes.data || []) {
      const id = String(s.client_id);
      const row = byClient.get(id) || { client_id: id, client_name: s.client_name, gt_owner: s.gt_owner, windows: {} };
      row.windows[Number(s.period_days)] = s;
      byClient.set(id, row);
    }
    const analysisMap = new Map((analysisRes.data || []).map((a: Row) => [String(a.client_id), a]));
    const clients = [...byClient.values()].map(c => ({ ...c, analysis: analysisMap.get(String(c.client_id)) || null }));
    return { clients, analyses: analysisRes.data || [], submission: submissionRes.data || null };
  }
  async function adminSummary(runId: string) {
    const [subs, snaps, analyses] = await Promise.all([
      ops.from("meta_gt_weekly_submissions").select("*").eq("run_id", runId).order("gt_person", { ascending: true }),
      ops.from("meta_performance_snapshots").select("client_id,gt_owner").eq("run_id", runId).eq("period_days", 7).limit(1000),
      ops.from("meta_gt_client_analyses").select("client_id,gt_person,evidence,diagnosis,hypothesis,decision,expected_result,next_validation,lead_quality_consulted,lead_quality_rating,lead_quality_notes").eq("run_id", runId).limit(1000),
    ]);
    const clientCount = new Map<string, Set<string>>();
    for (const s of snaps.data || []) { const gt = String(s.gt_owner || ""); if (!gt) continue; if (!clientCount.has(gt)) clientCount.set(gt, new Set()); clientCount.get(gt)!.add(String(s.client_id)); }
    const completeCount = new Map<string, number>();
    for (const a of analyses.data || []) {
      const complete = ["evidence","diagnosis","hypothesis","decision","expected_result","next_validation"].every(k => requiredText(a, k)) && a.lead_quality_consulted !== null && a.lead_quality_consulted !== undefined && requiredText(a, "lead_quality_notes") && (a.lead_quality_consulted === false || requiredText(a, "lead_quality_rating"));
      if (complete) completeCount.set(String(a.gt_person), (completeCount.get(String(a.gt_person)) || 0) + 1);
    }
    return (subs.data || []).map((s: Row) => ({ ...s, required_clients: clientCount.get(String(s.gt_person))?.size || 0, completed_clients: completeCount.get(String(s.gt_person)) || 0 }));
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const runId = url.searchParams.get("run_id") || url.searchParams.get("run");
      const requestedGt = url.searchParams.get("gt");
      const exportMode = String(url.searchParams.get("export") || "").toLowerCase();
      const { allRuns, run, gt } = await targetContext(runId, requestedGt);

      if (exportMode) {
        if (!isAdler) return json({ error: "not_found" }, 404);
        const exportGt = String(requestedGt || "").trim();
        let snapQ = ops.from("meta_performance_snapshots").select("client_id,client_name,gt_owner,period_days,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,leads,results,cpl,cost_per_result,data_status").eq("run_id", run.id).order("gt_owner", { ascending: true }).order("client_name", { ascending: true }).order("period_days", { ascending: true });
        let analysisQ = ops.from("meta_gt_client_analyses").select("*").eq("run_id", run.id).order("gt_person", { ascending: true });
        let submissionQ = ops.from("meta_gt_weekly_submissions").select("*").eq("run_id", run.id).order("gt_person", { ascending: true });
        if (exportGt) { snapQ = snapQ.eq("gt_owner", exportGt); analysisQ = analysisQ.eq("gt_person", exportGt); submissionQ = submissionQ.eq("gt_person", exportGt); }
        const [sRes, aRes, subRes] = await Promise.all([snapQ.limit(4000), analysisQ.limit(1000), submissionQ.limit(100)]);
        if (sRes.error || aRes.error || subRes.error) throw sRes.error || aRes.error || subRes.error;
        const metrics = new Map<string, Row>();
        for (const s of sRes.data || []) { const key = String(s.client_id); const r = metrics.get(key) || { client_id:key, client_name:s.client_name, gt_owner:s.gt_owner, windows:{} }; r.windows[Number(s.period_days)] = s; metrics.set(key,r); }
        const aMap = new Map((aRes.data || []).map((a: Row) => [String(a.client_id), a]));
        const subMap = new Map((subRes.data || []).map((s: Row) => [String(s.gt_person), s]));
        const header = ["snapshot","gt","status_entrega","nota_adler","cliente","3d_gasto","3d_resultados","3d_cpl","7d_gasto","7d_resultados","7d_cpl","14d_gasto","14d_resultados","14d_cpl","30d_gasto","30d_resultados","30d_cpl","evidencia","diagnostico","hipotese","decisao","por_que_decisao","resultado_esperado","risco_bloqueio","proxima_validacao","consultou_qualidade_leads","qualidade_leads","relato_qualidade_leads","data_consulta_qualidade","resumo_carteira","melhores_oportunidades","maiores_problemas","padroes_reconhecidos","previsao_proxima_semana","feedback_adler"];
        const rows: unknown[][] = [header];
        for (const m of metrics.values()) {
          const a = aMap.get(String(m.client_id)) || {}; const sub = subMap.get(String(m.gt_owner)) || {}; const w = m.windows;
          rows.push([run.snapshot_date,m.gt_owner,sub.status,sub.review_score,m.client_name,w[3]?.spend,w[3]?.results,w[3]?.cpl,w[7]?.spend,w[7]?.results,w[7]?.cpl,w[14]?.spend,w[14]?.results,w[14]?.cpl,w[30]?.spend,w[30]?.results,w[30]?.cpl,a.evidence,a.diagnosis,a.hypothesis,a.decision,a.decision_reason,a.expected_result,a.risk_blocker,a.next_validation,a.lead_quality_consulted===true?"SIM":a.lead_quality_consulted===false?"NÃO":"",a.lead_quality_rating,a.lead_quality_notes,a.lead_quality_checked_at,sub.portfolio_summary,sub.top_opportunities,sub.top_problems,sub.patterns_recognized,sub.forecast_next_week,sub.review_comment]);
        }
        return csv(rows, exportGt ? `analise-meta-${run.snapshot_date}-${exportGt.replace(/\s+/g,"-").toLowerCase()}.csv` : `analises-meta-${run.snapshot_date}-geral.csv`);
      }

      if (isAdler && !gt) return json({ profile: { person, role, is_adler: true }, runs: allRuns, selected_run: run, submissions: await adminSummary(String(run.id)) });
      const targetGt = gt || person;
      const detail = await loadGt(String(run.id), targetGt);
      return json({ profile: { person, role, is_adler: isAdler }, runs: allRuns, selected_run: run, gt_person: targetGt, ...detail, admin_summary: isAdler ? await adminSummary(String(run.id)) : undefined });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = String(body?.action || "");
      const { run } = await targetContext(String(body?.run_id || "") || null, isAdler ? String(body?.gt_person || "") : person);
      const runId = String(run.id);
      const gt = isAdler ? String(body?.gt_person || "").trim() : person;
      if (!gt) return json({ error: "gt_required" }, 400);

      if (action === "save_client") {
        if (isAdler) return json({ error: "adler_cannot_edit_gt_analysis" }, 403);
        const clientId = String(body?.client_id || "");
        const { data: scope } = await ops.from("meta_performance_snapshots").select("client_id").eq("run_id", runId).eq("client_id", clientId).eq("gt_owner", person).eq("period_days", 7).maybeSingle();
        if (!scope) return json({ error: "client_out_of_scope" }, 403);
        const leadConsulted = typeof body?.lead_quality_consulted === "boolean" ? body.lead_quality_consulted : null;
        const rating = clip(body?.lead_quality_rating, 30);
        const allowedRatings = new Set(["EXCELLENT","GOOD","MIXED","POOR","VERY_POOR","UNSURE"]);
        if (rating && !allowedRatings.has(rating)) return json({ error: "invalid_lead_quality_rating" }, 400);
        const payload = {
          run_id: runId, gt_person: person, client_id: clientId,
          evidence: clip(body?.evidence), diagnosis: clip(body?.diagnosis), hypothesis: clip(body?.hypothesis), decision: clip(body?.decision), decision_reason: clip(body?.decision_reason), expected_result: clip(body?.expected_result), risk_blocker: clip(body?.risk_blocker), next_validation: clip(body?.next_validation),
          lead_quality_consulted: leadConsulted, lead_quality_rating: leadConsulted ? rating : null, lead_quality_notes: clip(body?.lead_quality_notes), lead_quality_checked_at: body?.lead_quality_checked_at || null,
        };
        const { data, error } = await ops.from("meta_gt_client_analyses").upsert(payload, { onConflict: "run_id,gt_person,client_id" }).select("*").single();
        if (error) throw error;
        return json({ ok: true, analysis: data });
      }

      if (action === "save_portfolio") {
        if (isAdler) return json({ error: "adler_cannot_edit_gt_analysis" }, 403);
        const payload = { run_id:runId, gt_person:person, portfolio_summary:clip(body?.portfolio_summary), top_opportunities:clip(body?.top_opportunities), top_problems:clip(body?.top_problems), patterns_recognized:clip(body?.patterns_recognized), forecast_next_week:clip(body?.forecast_next_week) };
        const { data, error } = await ops.from("meta_gt_weekly_submissions").upsert(payload, { onConflict:"run_id,gt_person" }).select("*").single();
        if (error) throw error;
        return json({ ok:true, submission:data });
      }

      if (action === "submit") {
        if (isAdler) return json({ error: "adler_cannot_submit_for_gt" }, 403);
        const detail = await loadGt(runId, person);
        const missing: Row[] = [];
        for (const c of detail.clients) {
          const a = c.analysis || {};
          const fields = ["evidence","diagnosis","hypothesis","decision","decision_reason","expected_result","next_validation"];
          const absent = fields.filter(k => !requiredText(a,k));
          if (a.lead_quality_consulted === null || a.lead_quality_consulted === undefined) absent.push("lead_quality_consulted");
          if (!requiredText(a,"lead_quality_notes")) absent.push("lead_quality_notes");
          if (a.lead_quality_consulted === true && !requiredText(a,"lead_quality_rating")) absent.push("lead_quality_rating");
          if (absent.length) missing.push({ client_id:c.client_id, client_name:c.client_name, missing:absent });
        }
        const sub = detail.submission || {};
        const portfolioMissing = ["portfolio_summary","top_opportunities","top_problems","patterns_recognized","forecast_next_week"].filter(k => !requiredText(sub,k));
        if (missing.length || portfolioMissing.length) return json({ error:"analysis_incomplete", missing_clients:missing, missing_portfolio:portfolioMissing }, 422);
        const now = new Date().toISOString();
        const { error } = await ops.from("meta_gt_weekly_submissions").update({ status:"SUBMITTED", submitted_at:now }).eq("run_id",runId).eq("gt_person",person);
        if (error) throw error;
        await ops.from("work_items").update({ status:"COMPLETED", completed_at:now, completed_by:person, resolution:"Análise Meta semanal entregue pelo módulo de treinamento." }).eq("source","meta_gt_analysis").eq("source_id",`${runId}:${person}`).in("status",["OPEN","IN_PROGRESS","WAITING","SNOOZED"]);
        await ops.from("platform_notifications").upsert({ event_key:`meta_gt_analysis_submitted:${runId}:${person}`, type:"META_GT_ANALYSIS_SUBMITTED", level:"SUCCESS", title:`${person} entregou a análise Meta semanal`, description:`A leitura semanal da carteira foi entregue e está pronta para revisão.`, source:"meta_gt_analysis", actor:person, occurred_at:now, metadata:{ private_to_person:true,target_person:"Adler Furtado",target_role:"MGMT",meta_performance_run_id:runId,gt_person:person,route:`/meta-analysis?run=${runId}&gt=${encodeURIComponent(person)}&admin=1`,button_label:"Revisar análise" } }, { onConflict:"event_key" });
        return json({ ok:true,status:"SUBMITTED",submitted_at:now });
      }

      if (action === "review") {
        if (!isAdler) return json({ error:"not_found" },404);
        const decision = String(body?.decision || "REVIEWED");
        if (!["REVIEWED","REVISION_REQUESTED"].includes(decision)) return json({ error:"invalid_decision" },400);
        const scoreRaw = body?.review_score; const score = scoreRaw === null || scoreRaw === undefined || scoreRaw === "" ? null : Number(scoreRaw);
        if (score !== null && (!Number.isFinite(score) || score < 0 || score > 10)) return json({ error:"invalid_score" },400);
        const now = new Date().toISOString();
        const { data, error } = await ops.from("meta_gt_weekly_submissions").update({ status:decision, review_score:score, review_comment:clip(body?.review_comment), reviewed_at:now, reviewed_by:person }).eq("run_id",runId).eq("gt_person",gt).select("*").maybeSingle();
        if (error) throw error;
        if (!data) return json({ error:"submission_not_found" },404);
        if (decision === "REVISION_REQUESTED") await ops.from("work_items").update({ status:"OPEN", completed_at:null, completed_by:null, resolution:null }).eq("source","meta_gt_analysis").eq("source_id",`${runId}:${gt}`);
        await ops.from("platform_notifications").upsert({ event_key:`meta_gt_analysis_review:${runId}:${gt}:${decision}`, type:"META_GT_ANALYSIS_REVIEW", level:decision==="REVIEWED"?"SUCCESS":"ATTENTION", title:decision==="REVIEWED"?"Análise Meta semanal revisada":"Revisão solicitada na análise Meta", description:clip(body?.review_comment) || (decision==="REVIEWED"?"A análise semanal foi revisada pelo Adler.":"Abra a análise semanal, ajuste os pontos indicados e entregue novamente."), source:"meta_gt_analysis", actor:"Adler Furtado", occurred_at:now, metadata:{ private_to_person:true,target_person:gt,target_role:"GT",meta_performance_run_id:runId,route:`/meta-analysis?run=${runId}`,button_label:"Abrir análise" } }, { onConflict:"event_key" });
        return json({ ok:true,submission:data });
      }

      return json({ error:"invalid_action" },400);
    }

    return json({ error:"method_not_allowed" },405);
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e);
    if (message === "run_not_found") return json({ error:"run_not_found" },404);
    if (message === "forbidden") return json({ error:"not_found" },404);
    return json({ error:"server_error", detail:message.slice(0,800) },500);
  }
});
