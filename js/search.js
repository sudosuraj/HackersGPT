/* HackersGPT search helpers (no build step).
 *
 * Pattern: fetch live data in the browser, inject a grounded context block,
 * then send enriched messages to the model.
 *
 * This file defines `window.hgptSearch`.
 */

(function () {
  const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/i;
  const TRIGGERS_RE =
    /\b(search|look\s*up|lookup|find|latest|recent|newest|today|this\s+week|current|news|what(?:'| i)s new)\b/i;

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function normalizeForSearch(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function detectIntent(userText) {
    const text = String(userText || "");
    const m = text.match(CVE_RE);
    if (m) {
      return { needsSearch: true, kind: "cve", query: m[0].toUpperCase() };
    }
    if (TRIGGERS_RE.test(text)) {
      return { needsSearch: true, kind: "web", query: normalizeForSearch(text) };
    }
    return { needsSearch: false, kind: "none", query: "" };
  }

  async function fetchJson(url, { signal, timeoutMs = 12000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortUpstream = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abortUpstream, { once: true });
    }
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 180)}`);
      }
      return resp.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortUpstream);
    }
  }

  function mapSearxResults(json, maxResults) {
    const raw = Array.isArray(json?.results) ? json.results : [];
    const out = [];
    for (const r of raw) {
      const title = normalizeForSearch(r?.title);
      const url = String(r?.url || "").trim();
      const snippet = normalizeForSearch(r?.content || r?.snippet || "");
      if (!title && !url && !snippet) continue;
      out.push({
        title: title || url || "Result",
        url,
        snippet: snippet.slice(0, 360),
      });
      if (out.length >= maxResults) break;
    }
    return out;
  }

  async function searxSearch(query, { maxResults = 5, signal, basePath = "/api/search/searx" } = {}) {
    const count = clamp(Number(maxResults) || 5, 1, 10);
    const url = `${basePath}?q=${encodeURIComponent(query)}&count=${count}`;
    const json = await fetchJson(url, { signal, timeoutMs: 12000 });
    return mapSearxResults(json, count);
  }

  function mapNvdResults(json, maxItems) {
    const vulns = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities : [];
    const out = [];
    for (const v of vulns) {
      const cve = v?.cve;
      const id = String(cve?.id || "").trim();
      const descs = Array.isArray(cve?.descriptions) ? cve.descriptions : [];
      const en = descs.find((d) => d?.lang === "en")?.value || descs[0]?.value || "";
      const published = cve?.published || cve?.publishedDate || "";
      const lastModified = cve?.lastModified || cve?.lastModifiedDate || "";
      const references = Array.isArray(cve?.references) ? cve.references : [];
      const refUrl = references.find((r) => r?.url)?.url || "";

      out.push({
        id: id || "CVE",
        summary: normalizeForSearch(en).slice(0, 360),
        published,
        lastModified,
        url: refUrl,
      });
      if (out.length >= maxItems) break;
    }
    return out;
  }

  async function nvdSearch(query, { signal, basePath = "/api/search/nvd" } = {}) {
    const url = `${basePath}?q=${encodeURIComponent(query)}`;
    const json = await fetchJson(url, { signal, timeoutMs: 14000 });
    return mapNvdResults(json, 5);
  }

  function buildContextBlock({ intent, searxResults, nvdResults }) {
    const now = new Date().toISOString();
    const lines = [];

    lines.push("[LIVE_SEARCH_CONTEXT]");
    lines.push(`Time: ${now}`);
    lines.push(`Query: ${intent?.query || ""}`);
    lines.push("");
    lines.push("Instructions:");
    lines.push("- Use the results as grounding. If results conflict, say so.");
    lines.push("- Cite sources with bracket numbers like [W1] or [N1] when you use them.");
    lines.push("- If live data is insufficient, answer from general knowledge and say what was missing.");
    lines.push("");

    if (Array.isArray(searxResults) && searxResults.length) {
      lines.push("[WEB_RESULTS]");
      searxResults.forEach((r, i) => {
        lines.push(`[W${i + 1}] ${r.title}`);
        if (r.url) lines.push(`URL: ${r.url}`);
        if (r.snippet) lines.push(`Snippet: ${r.snippet}`);
        lines.push("");
      });
    }

    if (Array.isArray(nvdResults) && nvdResults.length) {
      lines.push("[NVD_RESULTS]");
      nvdResults.forEach((r, i) => {
        lines.push(`[N${i + 1}] ${r.id}`);
        if (r.published) lines.push(`Published: ${r.published}`);
        if (r.lastModified) lines.push(`LastModified: ${r.lastModified}`);
        if (r.url) lines.push(`Reference: ${r.url}`);
        if (r.summary) lines.push(`Summary: ${r.summary}`);
        lines.push("");
      });
    }

    lines.push("[END_LIVE_SEARCH_CONTEXT]");
    return lines.join("\n");
  }

  window.hgptSearch = {
    detectIntent,
    searxSearch,
    nvdSearch,
    buildContextBlock,
  };
})();

