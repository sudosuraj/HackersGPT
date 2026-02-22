export const config = {
  runtime: "edge",
};

function isSameOriginRequest(origin, host) {
  if (!origin || !host) return false;
  try {
    const u = new URL(origin);
    return u.hostname === host;
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default async function handler(request) {
  const origin = request.headers.get("origin");
  const host = (request.headers.get("host") || "").split(":")[0];
  const allowed = isSameOriginRequest(origin, host);

  if (request.method === "OPTIONS") {
    if (!allowed) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (!allowed) {
    return new Response(JSON.stringify({ error: "Forbidden origin" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const upstreamUrl = "https://llm7.io/v1/models";

  const headers = new Headers();
  const auth = request.headers.get("authorization");
  if (auth) headers.set("Authorization", auth);
  headers.set("Accept", "application/json");

  const upstream = await fetch(upstreamUrl, { method: "GET", headers });
  const outHeaders = new Headers(upstream.headers);
  outHeaders.set("Access-Control-Allow-Origin", origin);
  outHeaders.set("Vary", "Origin");

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
