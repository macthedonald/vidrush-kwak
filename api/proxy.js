// Same-origin proxy for CORS-blocked providers (Gathos, AI33, stock CDNs, R2 result URLs).
// Vercel Edge function: the browser hits /api/proxy on our own domain (no CORS), we relay
// to the target server-side. The caller passes the destination in the x-proxy-url header
// and its own Authorization / xi-api-key, which we forward (keys are never stored here).
export const config = { runtime: "edge" };

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

export default async function handler(request) {
  const target = request.headers.get("x-proxy-url");
  if (!target) return new Response("missing x-proxy-url", { status: 400 });
  let url;
  try { url = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
  if (url.protocol !== "https:" || !ALLOW.some((re) => re.test(url.hostname))) {
    return new Response("host not allowed", { status: 403 });
  }
  const headers = {};
  for (const h of ["authorization", "xi-api-key", "x-api-key", "content-type", "accept"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  // Browsers can't set User-Agent from fetch; some APIs (e.g. Wikimedia) 403 without one.
  headers["user-agent"] = "VidRush/1.0 (+https://kakkao.vercel.app)";
  const method = request.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  let upstream;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream fetch failed: " + e.message }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const respHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("content-type", ct);
  respHeaders.set("access-control-allow-origin", "*");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
