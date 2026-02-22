module.exports = function handler(req, res) {
  const origin = req.headers.origin;
  const host = (req.headers.host || "").split(":")[0];
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname !== host) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.statusCode = 403;
        res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
        return;
      }
    } catch {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, now: new Date().toISOString() }));
};
