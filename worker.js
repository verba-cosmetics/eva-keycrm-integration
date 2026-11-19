const EVA = "https://merchant-api.eva.ua/api/v1";
const CRM = "https://openapi.keycrm.app/v1";

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function request(url, options) {
  const r = await fetch(url, { ...options, redirect: "error" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function check(fn) {
  try { return { ok: true, ...(await fn()) }; }
  catch (e) { return { ok: false, error: /^HTTP \d+$/.test(e.message) ? e.message : "Connection or response error" }; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/") return reply({ service: "eva-keycrm-integration", mode: "diagnostic-only" });
    if (url.pathname !== "/check" || req.method !== "GET") return reply({ error: "Not found" }, 404);
    if (!env.ADMIN_TOKEN || req.headers.get("Authorization") !== "Bearer " + env.ADMIN_TOKEN) {
      return reply({ error: "Unauthorized" }, 401);
    }
    const [eva, keycrm] = await Promise.all([
      check(async () => {
        if (!env.EVA_USERNAME || !env.EVA_PASSWORD) return { ok: false, error: "Missing EVA secrets" };
        const token = await request(EVA + "/token", {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ username: env.EVA_USERNAME, password: env.EVA_PASSWORD })
        });
        if (!token.access) throw new Error("Unexpected token response");
        const orders = await request(EVA + "/orders?status=1&limit=20&offset=0", {
          headers: { Authorization: "Bearer " + token.access, Accept: "application/json" }
        });
        if (!Array.isArray(orders.results)) throw new Error("Unexpected orders response");
        return { new_order_count: orders.count ?? null, first_page_count: orders.results.length };
      }),
      check(async () => {
        if (!env.KEYCRM_API_KEY) return { ok: false, error: "Missing KeyCRM secret" };
        const sources = [];
        for (let page = 1; page <= 100; page++) {
          const result = await request(CRM + "/order/source?limit=50&page=" + page, {
            headers: { Authorization: "Bearer " + env.KEYCRM_API_KEY, Accept: "application/json" }
          });
          if (!Array.isArray(result.data)) throw new Error("Unexpected source response");
          sources.push(...result.data.filter(s => /eva/i.test(String(s.name))).map(s => ({ id: s.id, name: s.name })));
          if (result.last_page != null ? page >= Number(result.last_page) : !result.next_page_url && result.data.length < 50) return { matching_sources: sources };
        }
        return { ok: false, error: "Source pagination limit reached" };
      })
    ]);
    return reply({ mode: "diagnostic-only", eva, keycrm }, eva.ok && keycrm.ok ? 200 : 502);
  }
};
