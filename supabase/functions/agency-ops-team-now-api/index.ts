import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() => new Response(JSON.stringify({
  ok: false,
  disabled: true,
  reason: "feature_removed",
}), {
  status: 410,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
}));
