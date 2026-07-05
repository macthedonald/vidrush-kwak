// Some providers (Gathos, AI33, stock-video CDNs, Cloudflare R2 result URLs) don't send
// CORS headers, so the browser can't call them directly. Route those through our own
// same-origin proxy (/api/proxy — a Vercel Edge function in prod, a Vite middleware in dev).
// Same-origin means no browser CORS at all; the proxy relays server-side where CORS doesn't apply.
// The user's API key still travels from the browser (forwarded, never stored server-side).
const PROXY_HOSTS = [
  /(^|\.)gathos\.com$/,
  /(^|\.)ai33\.pro$/,
  /\.r2\.dev$/,
  /\.r2\.cloudflarestorage\.com$/,
  /(^|\.)suno\.ai$/,
  /(^|\.)pexels\.com$/,
  /(^|\.)pixabay\.com$/,
  /(^|\.)coverr\.co$/,
  /(^|\.)vimeocdn\.com$/,
];

export function needsProxy(url) {
  try { return PROXY_HOSTS.some((re) => re.test(new URL(url, location.href).hostname)); }
  catch { return false; }
}

// Drop-in fetch: transparently proxies CORS-blocked hosts, passes everything else through.
export function pfetch(url, opts = {}) {
  try {
    const u = new URL(url, location.href);
    if (PROXY_HOSTS.some((re) => re.test(u.hostname))) {
      return fetch("/api/proxy", { ...opts, headers: { ...(opts.headers || {}), "x-proxy-url": u.href } });
    }
  } catch {}
  return fetch(url, opts);
}
