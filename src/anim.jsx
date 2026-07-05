// Motion system built on anime.js — page reveals, counters, pop-ins.
import { useEffect, useRef } from "react";
import anime from "animejs/lib/anime.es.js";

export default anime;

const EASE = "cubicBezier(.16,1,.3,1)";

// Staggered entrance for an element's direct children.
export function revealChildren(el, opts = {}) {
  if (!el) return;
  const targets = Array.from(el.children);
  if (!targets.length) return;
  targets.forEach(t => { t.style.opacity = "0"; });
  anime({ targets, translateY: [6, 0], opacity: [0, 1], delay: anime.stagger(24), duration: 320, easing: EASE, ...opts });
}

// Hook: reveal the ref'd container's children when deps change.
export function useReveal(deps = []) {
  const ref = useRef(null);
  useEffect(() => { revealChildren(ref.current); }, deps);
  return ref;
}

// Hook: pop-in the ref'd element itself (modals, step panels).
export function usePopIn(deps = []) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    anime({ targets: ref.current, scale: [0.995, 1], opacity: [0, 1], duration: 200, easing: EASE });
  }, deps);
  return ref;
}

// Animated number counter.
export function Counter({ value, format }) {
  const ref = useRef(null);
  useEffect(() => {
    const o = { v: 0 };
    const a = anime({
      targets: o, v: value || 0, round: 1, duration: 700, easing: "easeOutExpo",
      update: () => { if (ref.current) ref.current.textContent = format ? format(o.v) : String(o.v); },
    });
    return () => a.pause();
  }, [value]);
  return <span ref={ref}>0</span>;
}

// Animated 0-100 score gauge value + bar width.
export function animateScore(el, barEl, score) {
  if (!el) return;
  const o = { v: 0 };
  anime({
    targets: o, v: score, round: 1, duration: 800, easing: "easeOutExpo",
    update: () => {
      el.textContent = o.v;
      if (barEl) barEl.style.width = o.v + "%";
    },
  });
}
