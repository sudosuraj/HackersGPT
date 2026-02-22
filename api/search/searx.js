async function fetchWithTimeout(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  const host = (req.headers.host || "").split(":")[0];
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === host;
  } catch {
    return false;
  }
}

const DEFAULT_INSTANCES = [
  // These can change over time; the route tries them in order.
  "https://searx.be",
  "https://search.inetol.net",
];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!originAllowed(req)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "Forbidden origin" }));
    return;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const q = String(req.query?.q || "").trim();
  const count = Math.max(1, Math.min(10, Number(req.query?.count || 5)));
  if (!q) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Missing q" }));
    return;
  }

  let lastText = "";
  for (const base of DEFAULT_INSTANCES) {
    const url = `${base.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&format=json&language=en&safesearch=0`;
    try {
      const upstream = await fetchWithTimeout(url, { timeoutMs: 12000 });
      const text = await upstream.text().catch(() => "");
      lastText = text;
      if (!upstream.ok) continue;
      // Return upstream JSON; client will slice to `count`.
      res.statusCode = 200;
      res.end(text);
      return;
    } catch (e) {
      lastText = e instanceof Error ? e.message : String(e);
    }
  }

  res.statusCode = 502;
  res.end(JSON.stringify({ error: "Search upstream failed", detail: lastText.slice(0, 220), count }));
};

