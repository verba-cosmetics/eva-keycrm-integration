const EVA = "https://merchant-api.eva.ua/api/v1";
const CRM = "https://openapi.keycrm.app/v1";
const REVISION = "diagnostic-v2";

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
function fail(stage, kind, details = {}) {
  throw { diagnostic: { stage, kind, ...details } };
}
function shape(value) {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}
async function request(stage, url, options) {
  let r;
  try {
    r = await fetch(url, { ...options, redirect: "manual" });
  } catch (e) {
    fail(stage, "fetch_failed", { exception: e instanceof TypeError ? "TypeError" : "Other" });
  }
  const http_status = r.status;
  const content_type = (r.headers.get("content-type") || "").split(";")[0].slice(0, 80);
  if (http_status >= 300 && http_status < 400) {
    let redirect_same_origin = null, redirect_trailing_slash = null;
    try {
      const target = new URL(r.headers.get("location"), url);
      const original = new URL(url);
      redirect_same_origin = target.origin === original.origin;
      redirect_trailing_slash = target.pathname === original.pathname + "/";
    } catch {}
    fail(stage, "redirect", { http_status, redirect_same_origin, redirect_trailing_slash });
  }
  if (!r.ok) fail(stage, "http_error", { http_status, content_type });
  try { return await r.json(); }
  catch { fail(stage, "invalid_json", { http_status, content_type }); }
}
async function check(fn) {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { return { ok: false, ...(e?.diagnostic || { kind: "unexpected_error" }) }; }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/") return reply({ service: "eva-keycrm-integration", mode: "diagnostic-only", revision: REVISION });
    if (url.pathname !== "/check" || req.method !== "GET") return reply({ error: "Not found" }, 404);
    if (!env.ADMIN_TOKEN || req.headers.get("Authorization") !== "Bearer " + env.ADMIN_TOKEN) return reply({ error: "Unauthorized" }, 401);
    const [eva, keycrm] = await Promise.all([
      check(async () => {
        if (!env.EVA_USERNAME || !env.EVA_PASSWORD) fail("eva_auth", "missing_secrets");
        const token = await request("eva_auth", EVA + "/token", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ username: env.EVA_USERNAME.trim(), password: env.EVA_PASSWORD })
        });
        if (typeof token?.access !== "string" || !token.access) fail("eva_auth", "unexpected_schema", { response_type: shape(token), has_access: Boolean(token?.access) });
        const orders = await request("eva_orders", EVA + "/orders?status=1&limit=20&offset=0", {
          headers: { Authorization: "Bearer " + token.access, Accept: "application/json" }
        });
        if (!Array.isArray(orders?.results)) fail("eva_orders", "unexpected_schema", { response_type: shape(orders), results_type: shape(orders?.results) });
        return { new_order_count: typeof orders.count === "number" ? orders.count : null, first_page_count: orders.results.length };
      }),
      check(async () => {
        if (!env.KEYCRM_API_KEY) fail("keycrm_sources", "missing_secret");
        const sources = [];
        for (let page = 1; page <= 5; page++) {
          if (page > 1) await new Promise(resolve => setTimeout(resolve, 3100));
          const result = await request("keycrm_sources", CRM + "/order/source?limit=50&page=" + page, {
            headers: { Authorization: "Bearer " + env.KEYCRM_API_KEY.trim(), Accept: "application/json" }
          });
          const entries = Array.isArray(result) ? result : result?.data;
          if (!Array.isArray(entries)) fail("keycrm_sources", "unexpected_schema", { response_type: shape(result), data_type: shape(result?.data) });
          sources.push(...entries.filter(s => /eva|ева|єва/i.test(String(s?.name))).map(s => ({ id: s.id, name: s.name })));
          if (Array.isArray(result) || (result.last_page != null ? page >= Number(result.last_page) : !result.next_page_url && entries.length < 50)) return { matching_sources: sources };
        }
        return { matching_sources: sources, pagination_complete: false };
      })
    ]);
    return reply({ mode: "diagnostic-only", revision: REVISION, eva, keycrm }, eva.ok && keycrm.ok ? 200 : 502);
  }
};
