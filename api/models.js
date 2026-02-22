async function fetchUpstreamModels(req) {
  const candidates = ["https://api.llm7.io/v1/models", "https://llm7.io/v1/models"];
  const headers = { Accept: "application/json" };
  headers.Authorization = req.headers.authorization || "Bearer unused";

  let last = null;
  for (const url of candidates) {
    const resp = await fetch(url, { method: "GET", headers });
    if (![404, 405, 501].includes(resp.status)) return resp;
    last = resp;
  }
  return last;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const origin = req.headers.origin;
  const host = (req.headers.host || "").split(":")[0];
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname !== host) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Forbidden origin" }));
        return;
      }
    } catch {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const upstream = await fetchUpstreamModels(req);
  if (!upstream) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "Upstream unavailable" }));
    return;
  }

  res.statusCode = upstream.status;
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  const body = await upstream.arrayBuffer().catch(() => null);
  res.end(body ? Buffer.from(body) : Buffer.from(""));
};
