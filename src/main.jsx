import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { cloudEnabled, CONVEX_URL, CLERK_KEY, fn, hydrateFromCloud, attachBackend, detachBackend, appLocalKeys } from "./cloud.js";

function Root() {
  // No Convex/Clerk configured → plain local-only app (unchanged behavior, zero setup).
  if (!cloudEnabled) return <App />;
  return <CloudApp />;
}

// Loaded only when configured, so unconfigured builds never touch Convex/Clerk.
function CloudApp() {
  const [mods, setMods] = useState(null);
  useEffect(() => {
    Promise.all([import("@clerk/clerk-react"), import("convex/react"), import("convex/react-clerk")])
      .then(([clerk, convexReact, convexClerk]) => {
        const client = new convexReact.ConvexReactClient(CONVEX_URL);
        setMods({ clerk, convexReact, convexClerk, client });
      });
  }, []);
  if (!mods) return <Splash label="Loading…" />;

  const { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } = mods.clerk;
  const { ConvexProviderWithClerk } = mods.convexClerk;
  return (
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/">
      <ConvexProviderWithClerk client={mods.client} useAuth={useAuth}>
        <SignedOut>
          <div className="cl-gate"><div className="cl-gate-inner">
            <div className="cl-brand"><span className="cl-mark">V</span>VidRush</div>
            <p className="cl-sub">Sign in to sync your niches, templates and learning memory across devices.</p>
            <SignIn routing="hash" />
          </div></div>
          <GateStyle />
        </SignedOut>
        <SignedIn>
          <CloudGate convexReact={mods.convexReact} />
        </SignedIn>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function CloudGate({ convexReact }) {
  const { useQuery, useMutation } = convexReact;
  const rows = useQuery(fn.list);
  const setKv = useMutation(fn.set);
  const setMany = useMutation(fn.setMany);
  const removeKv = useMutation(fn.remove);
  const [ready, setReady] = useState(false);
  const migrated = useRef(false);

  useEffect(() => {
    if (rows === undefined) return; // still loading
    hydrateFromCloud(rows);
    attachBackend(setKv, removeKv);
    // First sign-in: if the account is empty but this browser has prior local work, import it.
    if (!migrated.current) {
      migrated.current = true;
      if (rows.length === 0) {
        const keys = appLocalKeys();
        const entries = [];
        for (const k of keys) { try { const v = localStorage.getItem(k); if (v != null) entries.push({ key: k, value: JSON.parse(v) }); } catch {} }
        if (entries.length) setMany({ entries }).catch(() => {});
      }
    }
    setReady(true);
    return () => detachBackend();
  }, [rows]);

  if (!ready) return <Splash label="Syncing your workspace…" />;
  return <App />;
}

function Splash({ label }) {
  return <div className="yt-loading" style={{ flexDirection: "column", gap: 14 }}>
    <div className="yt-spin" style={{ width: 22, height: 22, border: "2px solid #d9d9d6", borderTopColor: "#1c1c1a", borderRadius: "50%", animation: "vSpin .7s linear infinite" }}/>
    <div style={{ fontFamily: "Inter, sans-serif", fontSize: 13, color: "#6f6e69" }}>{label}</div>
    <style>{"@keyframes vSpin{to{transform:rotate(360deg)}} .yt-loading{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}"}</style>
  </div>;
}

function GateStyle() {
  return <style>{`
    .cl-gate{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1100px 500px at 85% -10%,rgba(124,58,237,.06),transparent 60%),#fff;font-family:Inter,system-ui,sans-serif;padding:24px}
    .cl-gate-inner{display:flex;flex-direction:column;align-items:center;gap:14px;max-width:420px;width:100%}
    .cl-brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;color:#1c1c1a}
    .cl-mark{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#1c1c1a;color:#fff;font-size:15px;font-weight:700}
    .cl-sub{font-size:14px;color:#6f6e69;text-align:center;margin-bottom:6px}
  `}</style>;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
