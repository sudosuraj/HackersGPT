import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = "https://api.llm7.io/v1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function isPathSafe(p) {
  // Prevent path traversal.
  const full = resolve(join(__dirname, p));
  return full.startsWith(__dirname);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  if (!isPathSafe(pathname.slice(1))) {
    send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad path");
    return;
  }

  const filePath = join(__dirname, pathname);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
  }
}

async function proxy(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const upstreamPath = url.pathname.replace(/^\/api/, "");
  const upstreamUrl = `${UPSTREAM}${upstreamPath}${url.search}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const headers = {
    "Content-Type": req.headers["content-type"] || "application/json",
    Accept: req.headers["accept"] || "*/*",
  };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  const upstreamResp = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
  });

  res.writeHead(upstreamResp.status, {
    "Content-Type": upstreamResp.headers.get("content-type") || "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
  });

  if (!upstreamResp.body) {
    const text = await upstreamResp.text().catch(() => "");
    res.end(text);
    return;
  }

  const reader = upstreamResp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await proxy(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, msg);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`HackersGPT dev server: http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Proxy: /api/* -> ${UPSTREAM}/*`);
});
