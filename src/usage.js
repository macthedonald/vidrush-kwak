// Lightweight per-user usage counters (kept separate from the learning event log so it doesn't
// pollute the reflection signal). Each generation bumps a counter; the dashboard reads the totals.
import { cloudGet, cloudSet } from "./cloud.js";

const KEY = "vr8-usage";

export function bumpUsage(kind, n = 1) {
  try {
    const u = cloudGet(KEY, {}) || {};
    u[kind] = (u[kind] || 0) + n;
    cloudSet(KEY, u);
  } catch {}
}

export function getUsage() { return cloudGet(KEY, {}) || {}; }
export function resetUsage() { cloudSet(KEY, {}); }

// Rough per-unit cost estimates (USD) — editable in the dashboard, stored per user.
export const DEFAULT_RATES = {
  script: 0.03,   // one Claude script
  storyboard: 0.02,
  image: 0.01,    // one Gathos frame
  clip: 0.08,     // one Gathos video clip
  tts: 0.01,      // one voiceover section
  render: 0,      // in-browser, free
  publish: 0,
};
export const USAGE_LABELS = {
  script: "Scripts", storyboard: "Storyboards", image: "AI frames", clip: "AI clips",
  tts: "Voiceover sections", render: "Renders", publish: "Publishes",
};
export function getRates() { return { ...DEFAULT_RATES, ...(cloudGet("vr8-rates", {}) || {}) }; }
export function setRates(r) { cloudSet("vr8-rates", r); }
