// YouTube publishing + analytics via Google Identity Services (browser OAuth token flow).
// No client secret and no server exchange: GIS hands the SPA a short-lived access token for the
// requested scopes. The Client ID is public (safe in the bundle); override with VITE_GOOGLE_CLIENT_ID.
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "57865949450-v9lhkcbopu693amldmge8ep1icq4670g.apps.googleusercontent.com";

// One consent covers both features: upload + manage (thumbnails/metadata) + analytics read.
export const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

let gisReady = null;
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => res(); s.onerror = () => rej(new Error("Couldn't load Google sign-in — check your connection"));
    document.head.appendChild(s);
  });
  return gisReady;
}

let cachedToken = null;
// Request (or silently refresh) an access token for the given scopes.
export async function connectYouTube(scopes = YT_SCOPES) {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: scopes.join(" "),
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        cachedToken = resp.access_token;
        resolve(resp.access_token);
      },
    });
    client.requestAccessToken({ prompt: cachedToken ? "" : "consent" });
  });
}
export function youTubeToken() { return cachedToken; }

// Resumable upload of a rendered MP4. Returns the created video resource ({ id, ... }).
export async function uploadVideo({ token, blob, title, description = "", tags = [], privacyStatus = "private", publishAt = null, onProgress }) {
  const status = { privacyStatus, selfDeclaredMadeForKids: false };
  if (publishAt) { status.privacyStatus = "private"; status.publishAt = publishAt; } // scheduled = private until publishAt
  const meta = { snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags, categoryId: "22" }, status };
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": blob.type || "video/mp4",
      "X-Upload-Content-Length": String(blob.size),
    },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`YouTube upload init failed (${init.status}) ${await init.text()}`.slice(0, 300));
  const uploadUrl = init.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube didn't return an upload URL");
  // PUT the bytes via XHR so we get real progress on large files.
  const video = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", blob.type || "video/mp4");
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } }
      else reject(new Error(`YouTube upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(blob);
  });
  return video;
}

export async function setThumbnail({ token, videoId, blob }) {
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type || "image/png" }, body: blob,
  });
  if (!r.ok) throw new Error(`Thumbnail set failed (${r.status})`);
  return r.json();
}

export async function myChannelId(token) {
  const r = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `channels ${r.status}`);
  return d.items?.[0]?.id || null;
}

// Lifetime per-video performance for the given video ids. Rows → [{videoId, views, ...}].
export async function videoAnalytics(token, channelId, videoIds) {
  if (!videoIds.length) return [];
  const params = new URLSearchParams({
    ids: `channel==${channelId}`,
    startDate: "2005-01-01",
    endDate: new Date().toISOString().slice(0, 10),
    metrics: "views,estimatedMinutesWatched,averageViewPercentage,likes,subscribersGained",
    dimensions: "video",
    filters: `video==${videoIds.slice(0, 200).join(",")}`,
    sort: "-views",
    maxResults: "200",
  });
  const r = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `analytics ${r.status}`);
  return (d.rows || []).map((row) => ({
    videoId: row[0], views: row[1], minutesWatched: row[2], avgViewPct: row[3], likes: row[4], subscribersGained: row[5],
  }));
}
