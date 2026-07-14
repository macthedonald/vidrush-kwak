// Tiny JSON KV over Upstash Redis (same creds morphic already uses for rate limiting),
// with an in-memory fallback so dev / single-instance runs work without Redis. Used to
// hand large payloads (e.g. voiceover word-timings) between tool calls by a short id,
// instead of threading the whole array through the model's tool arguments.
import { Redis } from '@upstash/redis'

const mem = new Map<string, { value: string; expires: number }>()

function redis(): Redis | null {
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    return null
  }
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  })
}

export async function kvSetJSON(
  key: string,
  value: unknown,
  ttlSeconds = 60 * 60 * 6
): Promise<void> {
  const json = JSON.stringify(value)
  const r = redis()
  if (r) {
    await r.set(key, json, { ex: ttlSeconds })
    return
  }
  mem.set(key, { value: json, expires: Date.now() + ttlSeconds * 1000 })
}

export async function kvGetJSON<T>(key: string): Promise<T | null> {
  const r = redis()
  if (r) {
    const v = await r.get<string>(key)
    if (v == null) return null
    // Upstash may return an already-parsed object or a JSON string.
    return typeof v === 'string' ? (JSON.parse(v) as T) : (v as T)
  }
  const hit = mem.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    mem.delete(key)
    return null
  }
  return JSON.parse(hit.value) as T
}
