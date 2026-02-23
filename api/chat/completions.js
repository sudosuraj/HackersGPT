module.exports.config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function getHeader(req, name) {
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? req.headers[key] : null;
}

async function proxyOnce(req, body, url) {
  const contentType = getHeader(req, "content-type");
  const accept = getHeader(req, "accept");
  let auth = getHeader(req, "authorization");

  if (auth && /^Bearer\s+Bearer\s+/i.test(auth)) {
    auth = auth.replace(/^Bearer\s+/i, "");
  }

  const headers = {
    "Content-Type": contentType || "application/json",
    Accept: accept || "*/*",
    Authorization: auth || "Bearer unused",
  };

  return fetch(url, { method: "POST", headers, body });
}

async function fetchUpstream(req, body) {
  const candidates = [
    "https://api.llm7.io/v1/chat/completions",
    "https://llm7.io/v1/chat/completions",
  ];
  let last = null;
  for (const url of candidates) {
    const resp = await proxyOnce(req, body, url);
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

  if (req.method !== "POST") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const body = await readRawBody(req);
  const upstream = await fetchUpstream(req, body);
  if (!upstream) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "Upstream unavailable" }));
    return;
  }

  res.statusCode = upstream.status;
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);

  // Stream response through (supports SSE).
  if (upstream.body && upstream.body.getReader) {
    const reader = upstream.body.getReader();
    const cancel = () => {
      try {
        reader.cancel();
      } catch {
        // ignore
      }
    };
    req.on("close", cancel);
    res.on("close", cancel);

    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    } catch {
      // ignore stream errors; end response
    }
    res.end();
    return;
  }

  const text = await upstream.text().catch(() => "");
  res.end(text);
};
