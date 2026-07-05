// Self-learning memory: every meaningful action is logged per niche, and a periodic
// "reflection" distills the log into a compact preferences note that gets injected
// into future briefs, scripts, storyboards, and SEO prompts. The app gets sharper
// the more videos you finish.
//
// Storage goes through the cloud store, so when signed into Convex the memory is
// per-user and sticky across devices; otherwise it lives in localStorage.
import { claude } from "./pipeline";
import { cloudGet, cloudSet, cloudRemove } from "./cloud.js";

const EV_KEY = id => `vr8-mem-${id}`;
const LS_KEY = id => `vr8-lessons-${id}`;
const MARK_KEY = id => `vr8-mem-mark-${id}`;

export function recordEvent(nicheId, type, data = {}) {
  const k = EV_KEY(nicheId);
  const arr = cloudGet(k, []);
  const next = Array.isArray(arr) ? arr.slice() : [];
  next.push({ t: Date.now(), type, ...data });
  while (next.length > 120) next.shift();
  cloudSet(k, next);
}
export function getEvents(nicheId) {
  const v = cloudGet(EV_KEY(nicheId), []);
  return Array.isArray(v) ? v : [];
}
export function getLessons(nicheId) {
  return cloudGet(LS_KEY(nicheId), "") || "";
}
export function setLessons(nicheId, txt) {
  if (txt) cloudSet(LS_KEY(nicheId), txt); else cloudRemove(LS_KEY(nicheId));
}
export function clearMemory(nicheId) {
  cloudRemove(EV_KEY(nicheId)); cloudRemove(LS_KEY(nicheId)); cloudRemove(MARK_KEY(nicheId));
}

// Prompt fragment injected into generation calls.
export function lessonsNote(nicheId) {
  const l = getLessons(nicheId);
  return l ? `\n\nLEARNED PREFERENCES from past videos on this channel — apply these unless they conflict with an explicit instruction:\n${l}` : "";
}

const SYS_REFLECT = `You maintain a compact working memory of a YouTube creator's preferences, learned from their activity log (edits they made, prompts they redid, voices/styles/templates they chose, what they shipped).
Update the memory note. Infer durable preferences from the evidence: tone and sentence style (compare before/after edits), visual styles they redo vs keep, pacing, voice choices, structural habits, SEO patterns. Drop anything the new evidence contradicts. Never invent preferences without evidence.
Return ONLY the updated memory note as plain prose bullets, maximum 350 words. No preamble, no headers.`;

let lastReflect = 0;
// Fire-and-forget; throttled so it costs at most one small call every few minutes.
export async function reflect(nicheId, clKey) {
  if (!clKey || Date.now() - lastReflect < 180000) return;
  const evs = getEvents(nicheId);
  const since = +cloudGet(MARK_KEY(nicheId), 0) || 0;
  const fresh = evs.filter(e => e.t > since);
  if (fresh.length < 4) return;
  lastReflect = Date.now();
  try {
    const prev = getLessons(nicheId);
    const log = evs.slice(-60).map(e => JSON.stringify(e)).join("\n").slice(0, 12000);
    const out = await claude(SYS_REFLECT, `PREVIOUS MEMORY:\n${prev || "(none yet)"}\n\nRECENT ACTIVITY LOG (newest last):\n${log}`, clKey);
    if (out.trim()) {
      setLessons(nicheId, out.trim().slice(0, 4000));
      cloudSet(MARK_KEY(nicheId), Date.now());
    }
  } catch (e) { console.warn("reflect:", e.message); }
}
