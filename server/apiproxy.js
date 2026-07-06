// Local counterpart of api/proxy.js — a Vite middleware so /api/proxy works under
// `npm run dev` and `npm run preview` exactly as the Vercel Edge function does in prod.
const ALLOW = [
  /(^|\.)gathos\.com$/,
  /(^|\.)ai33\.pro$/,
  /\.r2\.dev$/,
  /\.r2\.cloudflarestorage\.com$/,
  /(^|\.)suno\.ai$/,
  /(^|\.)pexels\.com$/,
  /(^|\.)pixabay\.com$/,
  /(^|\.)coverr\.co$/,
  /(^|\.)vimeocdn\.com$/,
  /(^|\.)wikimedia\.org$/,
  /(^|\.)wikipedia\.org$/,
  /(^|\.)archive\.org$/,
  /(^|\.)archives\.gov$/,
  /(^|\.)s3\.amazonaws\.com$/,
];

async function handle(req, res, next) {
  let u;
  try { u = new URL(req.url, "http://localhost"); } catch { return next(); }
  if (u.pathname !== "/api/proxy") return next();

  const target = req.headers["x-proxy-url"];
  if (!target) { res.statusCode = 400; res.end("missing x-proxy-url"); return; }
  let url;
  try { url = new URL(target); } catch { res.statusCode = 400; res.end("bad url"); return; }
  if (url.protocol !== "https:" || !ALLOW.some((re) => re.test(url.hostname))) {
    res.statusCode = 403; res.end("host not allowed"); return;
  }
  const headers = {};
  for (const h of ["authorization", "xi-api-key", "x-api-key", "content-type", "accept"]) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  // Browsers can't set User-Agent from fetch; some APIs (e.g. Wikimedia) 403 without one.
  headers["user-agent"] = "VidRush/1.0 (+https://kakkao.vercel.app)";
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    res.statusCode = upstream.status;
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    res.statusCode = 502; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "upstream fetch failed: " + e.message }));
  }
}

export default function apiProxy() {
  return {
    name: "api-proxy",
    configureServer(server) { server.middlewares.use(handle); },
    configurePreview(server) { server.middlewares.use(handle); },
  };
}
