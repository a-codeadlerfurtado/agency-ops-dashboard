from pathlib import Path
p=Path('app/page.tsx')
s=p.read_text()
old='import { API_URL, CONTRACTS_API, SUPABASE_ANON_KEY, BrandMark, Chip, Metric, api, apiPost, clickupAction, daysSince, formatDate, formatDay, formatMoney, formatNumber, healthScore, initials, priorityRank, taskCompletion, pt, relativeDate, supabase, text, useDialogFocus } from "./shared";'
new='import { API_URL, CONTRACTS_API, SUPABASE_ANON_KEY, SUPABASE_URL, BrandMark, Chip, Metric, api, apiPost, clickupAction, daysSince, formatDate, formatDay, formatMoney, formatNumber, healthScore, initials, priorityRank, taskCompletion, pt, relativeDate, supabase, text, useDialogFocus } from "./shared";'
if s.count(old)!=1: raise SystemExit('import anchor changed')
s=s.replace(old,new,1)
old='''      const next = await api("home", session.access_token);
      preferencesRef.current = next.preferences || {};'''
new='''      const [next, profileData] = await Promise.all([
        api("home", session.access_token),
        fetch(`${SUPABASE_URL}/functions/v1/agency-ops-profile-data-api`, {
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store",
        }).then(async (response) => response.ok ? response.json() : null).catch(() => null),
      ]);
      if (profileData?.focus) {
        next.operations = { ...(next.operations || {}), [profileData.profile?.role === "DESIGN" ? "design_focus" : "personal_focus"]: profileData.focus };
        next.profile = { ...(next.profile || {}), clickup_user_id: profileData.profile?.clickup_user_id ?? null };
        if (Array.isArray(profileData.client_gt) && profileData.client_gt.length) {
          const gtByClient = new Map(profileData.client_gt.map((row: Row) => [String(row.client_id), row.gt_owner ?? null]));
          next.clients = (next.clients || []).map((client: Row) => ({ ...client, gt_owner: gtByClient.has(String(client.client_id)) ? gtByClient.get(String(client.client_id)) : client.gt_owner }));
        }
      }
      preferencesRef.current = next.preferences || {};'''
if s.count(old)!=1: raise SystemExit('load anchor changed')
s=s.replace(old,new,1)
p.write_text(s)
