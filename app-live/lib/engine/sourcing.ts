// VidRush engine — real-footage sourcing, ported server-side from the proven studio pipeline.
// Pools candidates from Wikimedia Commons + Internet Archive (+ NARA with a key), ranks by
// term relevance, and optionally vision-verifies with Gemini so the pick actually depicts
// the subject. Server-side fetch: no CORS, and we can send a proper User-Agent.
const UA = { 'User-Agent': 'VidRushLive/1.0 (+https://github.com/macthedonald/vidrush-live)' }

export interface FootageAsset {
  kind: 'video' | 'photo'
  src: string
  thumb: string
  title: string
  credit: string
  url: string
  source: string
  score?: number
  needsResolve?: boolean
  identifier?: string
}

const STOP = new Set(
  'the a an and or of in on at to for with from into over under this that these those is are was were be being real actual footage clip video photo image shot scene view close up wide angle shows showing depicting depicts'.split(' ')
)
export function queryTerms(s: string): Set<string> {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !STOP.has(w))
  )
}
const REAL_SOURCES = new Set(['Wikimedia Commons', 'Internet Archive', 'U.S. National Archives'])
export function scoreAsset(qterms: Set<string>, a: FootageAsset): number {
  const at = queryTerms([a.title, a.credit].join(' '))
  let hit = 0
  for (const t of qterms) if (at.has(t)) hit++
  let s = hit / Math.max(3, qterms.size)
  if (a.kind === 'video') s += 0.05
  if (REAL_SOURCES.has(a.source)) s += 0.12
  return s
}

export async function wikimediaMedia(query: string, limit = 8): Promise<FootageAsset[]> {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1280&format=json&origin=*`
  const r = await fetch(u, { headers: UA })
  if (!r.ok) throw new Error(`Wikimedia ${r.status}`)
  const d = await r.json()
  const pages = d.query?.pages ? Object.values(d.query.pages) : []
  return (pages as any[])
    .map((p): FootageAsset | null => {
      const ii = p.imageinfo?.[0]
      if (!ii) return null
      const mime = ii.mime || ''
      const isVid = /^video\//.test(mime) || /\.(webm|ogv|ogg|mp4)$/i.test(ii.url || '')
      const isImg = /^image\//.test(mime) && !/svg/.test(mime)
      if (!isVid && !isImg) return null
      const title = (p.title || '').replace(/^File:/, '').replace(/\.\w+$/, '').replace(/_/g, ' ')
      const artist = (ii.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      const license = ii.extmetadata?.LicenseShortName?.value || ''
      return {
        kind: isVid ? 'video' : 'photo',
        src: isVid ? ii.url : ii.thumburl || ii.url,
        thumb: ii.thumburl || ii.url,
        title,
        credit: `${title}${artist ? ' — ' + artist : ''}${license ? ' (' + license + ')' : ''}, via Wikimedia Commons`,
        url: ii.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title || '')}`,
        source: 'Wikimedia Commons'
      }
    })
    .filter((x): x is FootageAsset => !!x)
}

export async function archiveVideos(query: string, limit = 6): Promise<FootageAsset[]> {
  const u = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query + ' AND mediatype:(movies)')}&fl[]=identifier&fl[]=title&fl[]=year&rows=${limit}&output=json`
  const r = await fetch(u, { headers: UA })
  if (!r.ok) throw new Error(`Internet Archive ${r.status}`)
  const d = await r.json()
  return (d.response?.docs || []).map((doc: any): FootageAsset => ({
    kind: 'video',
    identifier: doc.identifier,
    src: '',
    needsResolve: true,
    title: doc.title || doc.identifier,
    thumb: `https://archive.org/services/img/${doc.identifier}`,
    credit: `${doc.title || doc.identifier}${doc.year ? ' (' + doc.year + ')' : ''} — Internet Archive`,
    url: `https://archive.org/details/${doc.identifier}`,
    source: 'Internet Archive'
  }))
}

export async function archiveResolveFile(a: FootageAsset): Promise<FootageAsset | null> {
  if (!a.identifier) return a
  const r = await fetch(`https://archive.org/metadata/${a.identifier}`, { headers: UA })
  if (!r.ok) return null
  const d = await r.json()
  const files: any[] = d.files || []
  const byExt = (re: RegExp, extra: (f: any) => boolean = () => true) =>
    files.find(f => re.test(f.name || '') && extra(f))
  const pick =
    byExt(/\.mp4$/i, f => f.source === 'derivative') ||
    byExt(/\.mp4$/i) ||
    byExt(/\.(webm|ogv)$/i) ||
    byExt(/\.(m4v|mov)$/i)
  if (!pick) return null
  return {
    ...a,
    src: `https://archive.org/download/${a.identifier}/${encodeURIComponent(pick.name)}`,
    needsResolve: false
  }
}

export async function naraMedia(query: string, key: string, limit = 8): Promise<FootageAsset[]> {
  if (!key) return []
  const u = `https://catalog.archives.gov/api/v2/records/search?q=${encodeURIComponent(query)}&limit=${limit}&availableOnline=true`
  const r = await fetch(u, { headers: { ...UA, 'x-api-key': key } })
  if (!r.ok) throw new Error(`National Archives ${r.status}`)
  const d = await r.json().catch(() => ({}) as any)
  const hits = d.body?.hits?.hits || d.hits?.hits || d.hits || []
  const out: FootageAsset[] = []
  for (const h of hits) {
    const rec = h.fields?.record || h.fields || h._source?.record || h._source || h.record || {}
    const objs = rec.digitalObjects || rec.record?.digitalObjects || []
    const title = rec.title || rec.record?.title || 'National Archives record'
    const naId = rec.naId || rec.record?.naId || h._id
    for (const o of objs) {
      const url = o.objectUrl || o.url || o.objectFileUrl
      if (!url) continue
      const type = `${o.objectType || ''} ${url}`.toLowerCase()
      const kind = /video|mp4|mpeg|mov|\.m4v|\.webm/.test(type)
        ? ('video' as const)
        : /image|photo|jpg|jpeg|png|gif|tif/.test(type)
          ? ('photo' as const)
          : null
      if (!kind) continue
      out.push({
        kind,
        src: url,
        thumb: o.thumbnailUrl || o.thumbnail || url,
        title,
        credit: `${title} — U.S. National Archives${naId ? ' (NAID ' + naId + ')' : ''}`,
        url: naId ? `https://catalog.archives.gov/id/${naId}` : 'https://catalog.archives.gov',
        source: 'U.S. National Archives'
      })
      break
    }
  }
  return out
}

// Pool the media that morphic's own search stack can already see. This is the hybrid
// bridge the user asked for: footage sourcing is NOT limited to Wikimedia/Archive/NARA —
// it also draws on whatever provider morphic is configured with (Tavily/Exa/Brave/
// Firecrawl/SearXNG), reusing their image + video results as extra candidates. We import
// the provider factory lazily so this engine module stays usable outside the Next runtime.
export async function morphicMedia(query: string, limit = 8): Promise<FootageAsset[]> {
  const q = String(query || '').trim()
  if (!q) return []
  let createSearchProvider: (typeof import('@/lib/tools/search/providers'))['createSearchProvider']
  try {
    ;({ createSearchProvider } = await import('@/lib/tools/search/providers'))
  } catch {
    return []
  }
  const provider = createSearchProvider()
  let res
  try {
    res = await provider.search(q, limit, 'basic', [], [], {
      content_types: ['image', 'video']
    })
  } catch {
    return []
  }
  const providerLabel = (process.env.SEARCH_API || 'tavily')
    .replace(/^\w/, c => c.toUpperCase())
  const out: FootageAsset[] = []

  // Video results (Serper-shaped: link is the watch/page URL, imageUrl is the thumbnail).
  for (const v of res.videos || []) {
    const link = v.link || ''
    if (!link) continue
    out.push({
      kind: 'video',
      src: link,
      thumb: v.imageUrl || link,
      title: v.title || 'Web video',
      credit: `${v.title || 'Web video'}${v.channel || v.source ? ' — ' + (v.channel || v.source) : ''}, via ${providerLabel} search`,
      url: link,
      source: `Web (${providerLabel})`,
      needsResolve: true
    })
  }

  // Image results — either bare URL strings or {url, description, title?, sourceUrl?}.
  for (const img of res.images || []) {
    const url = typeof img === 'string' ? img : img.url
    if (!url) continue
    const title =
      typeof img === 'string' ? '' : img.title || img.description || ''
    const page = typeof img === 'string' ? '' : img.sourceUrl || ''
    out.push({
      kind: 'photo',
      src: url,
      thumb: url,
      title: title || 'Web image',
      credit: `${title || 'Web image'}, via ${providerLabel} search`,
      url: page || url,
      source: `Web (${providerLabel})`
    })
  }
  return out.slice(0, limit)
}

// Pool candidates across all real sources for a set of queries, term-ranked.
export async function sourceCandidates(
  queries: string[],
  {
    limit = 8,
    naraKey = process.env.NARA_API_KEY || '',
    includeWeb = true
  } = {}
): Promise<FootageAsset[]> {
  const qs = queries.map(q => String(q || '').trim()).filter(Boolean)
  if (!qs.length) return []
  const q0 = qs[0]
  const q1 = qs[1] || qs[0]
  const qterms = queryTerms(qs.join(' '))
  const jobs: Promise<FootageAsset[]>[] = [wikimediaMedia(q0, 8), archiveVideos(q0, 6)]
  if (q1 !== q0) jobs.push(wikimediaMedia(q1, 6))
  if (naraKey) jobs.push(naraMedia(q0, naraKey, 8))
  // Hybrid: fold in morphic's configured web search provider (image + video) so the
  // footage pool spans open archives AND the general web that morphic already indexes.
  if (includeWeb) {
    jobs.push(morphicMedia(q0, 8))
    if (q1 !== q0) jobs.push(morphicMedia(q1, 6))
  }
  const settled = await Promise.allSettled(jobs)
  const pool: FootageAsset[] = []
  for (const s of settled) if (s.status === 'fulfilled') pool.push(...s.value)
  pool.forEach(a => (a.score = scoreAsset(qterms, a)))
  pool.sort((a, b) => (b.score || 0) - (a.score || 0))
  return pool.slice(0, limit)
}

// Optional Gemini vision verification: look at the thumbnails and pick the candidate that
// ACTUALLY depicts the scene (text/watermark-free). Returns winning index or -1 for none.
export async function geminiPickAsset(
  candidates: FootageAsset[],
  intent: string,
  key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
): Promise<number> {
  if (!key) throw new Error('no Gemini key')
  const withThumbs: { i: number; mime: string; data: string }[] = []
  await Promise.all(
    candidates.slice(0, 6).map(async (c, i) => {
      try {
        const r = await fetch(c.thumb || c.src, { headers: UA })
        if (!r.ok) return
        const ct = r.headers.get('content-type') || 'image/jpeg'
        if (!/^image\//.test(ct)) return
        const buf = Buffer.from(await r.arrayBuffer())
        withThumbs.push({ i, mime: ct, data: buf.toString('base64') })
      } catch {}
    })
  )
  if (!withThumbs.length) throw new Error('no readable thumbnails')
  withThumbs.sort((a, b) => a.i - b.i)
  const parts: any[] = [
    {
      text: `You are selecting b-roll for one video scene.\nSCENE NEEDS: ${intent}\n\nBelow are ${withThumbs.length} candidate images, numbered in order. Judge each on:\n1. Does it ACTUALLY depict the subject the scene needs (not vaguely related)?\n2. Is it free of burned-in text, captions, numbers, watermarks, logos and UI?\n3. Is it visually usable (clear subject, decent quality)?\nReturn ONLY JSON: {"best": <0-based number of the single best candidate, or -1 if NONE truly matches>, "reason": "one short sentence"}`
    }
  ]
  withThumbs.forEach((t, k) => {
    parts.push({ text: `Candidate ${k}:` })
    parts.push({ inline_data: { mime_type: t.mime, data: t.data } })
  })
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 200, responseMimeType: 'application/json' }
  }
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  const d = await resp.json().catch(() => ({}) as any)
  if (!resp.ok) throw new Error(d.error?.message || `Gemini ${resp.status}`)
  const text = (d.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('')
  const out = JSON.parse(text)
  const k = typeof out.best === 'number' ? out.best : -1
  if (k < 0 || k >= withThumbs.length) return -1
  return withThumbs[k].i
}

// Full sourcing flow: pool + rank + (optionally) vision-verify + resolve the winner.
export async function sourceFootage(
  queries: string[],
  intent: string,
  { limit = 8 } = {}
): Promise<{ candidates: FootageAsset[]; best: FootageAsset | null; visionVerified: boolean }> {
  const pool = await sourceCandidates(queries, { limit })
  if (!pool.length) return { candidates: [], best: null, visionVerified: false }
  let order = pool.map((_, i) => i)
  let visionVerified = false
  try {
    const best = await geminiPickAsset(pool, intent || queries.join('; '))
    visionVerified = true
    if (best === -1) return { candidates: pool, best: null, visionVerified }
    order = [best, ...order.filter(i => i !== best)]
  } catch {
    /* no Gemini key or vision failure → term ranking */
  }
  for (const i of order.slice(0, 6)) {
    const cand = pool[i]
    if (!cand.needsResolve) return { candidates: pool, best: cand, visionVerified }
    try {
      const resolved = await archiveResolveFile(cand)
      if (resolved) return { candidates: pool, best: resolved, visionVerified }
    } catch {}
  }
  return { candidates: pool, best: null, visionVerified }
}
