// Vercel build entrypoint.
// If CONVEX_DEPLOY_KEY is set, push the Convex functions to the linked deployment
// and inject its URL as VITE_CONVEX_URL before building — this makes cloud sync
// (accounts + sticky per-user memory) live. If the key is absent, we just build:
// the app degrades gracefully to its localStorage fallback (no sign-in gate).
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

if (process.env.CONVEX_DEPLOY_KEY) {
  console.log("→ CONVEX_DEPLOY_KEY detected: deploying Convex functions, then building.");
  run("npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL");
} else {
  console.log("→ No CONVEX_DEPLOY_KEY: building without cloud sync (localStorage fallback).");
  run("npm run build");
}
