async function fetchWithTimeout(url, { timeoutMs = 14000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
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

const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/i;

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
  if (!q) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Missing q" }));
    return;
  }

  const cveMatch = q.match(CVE_RE);
  const params = new URLSearchParams();
  params.set("resultsPerPage", "5");
  if (cveMatch) params.set("cveId", cveMatch[0].toUpperCase());
  else params.set("keywordSearch", q);

  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?${params.toString()}`;
  const upstream = await fetchWithTimeout(url, { timeoutMs: 14000 });
  const text = await upstream.text().catch(() => "");
  res.statusCode = upstream.status;
  res.end(text);
};

