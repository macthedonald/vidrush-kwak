# Self-host a cobalt extractor (for production YouTube pulls)

VidRush's live site pulls YouTube (Creative-Commons) clips through a **cobalt** instance,
because YouTube blocks direct downloads from datacenter IPs like Vercel's. Stand one up with
any of the options below, then point VidRush at it.

> You only need this for **YouTube** clips. Wikimedia Commons and Internet Archive footage work
> on the live site with **no setup**.

Once your instance is running, in **Vercel → your project → Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `COBALT_API_URL` | your instance's public URL, e.g. `https://cobalt.yourdomain.com/` |
| `COBALT_API_KEY` | *(only if you enabled key auth)* one of the keys from `keys.json` |

Then **redeploy** VidRush. Pick **short** clips — long videos can exceed serverless limits.

---

## Option A — Docker on a VPS (recommended)

Any small VPS (1 shared CPU / 512MB is plenty) with a domain + HTTPS reverse proxy
(Caddy/Nginx/Traefik) in front.

```bash
git clone <this repo> && cd deploy/cobalt
export COBALT_PUBLIC_URL="https://cobalt.yourdomain.com/"   # must match how you reach it
docker compose up -d
```

Point your reverse proxy at `127.0.0.1:9000`. That's it — `COBALT_PUBLIC_URL` **must**
exactly equal the public URL (with trailing slash), or cobalt rejects requests.

Quick local test (no domain): leave the default `http://localhost:9000/` and
`curl -s -X POST http://localhost:9000/ -H 'content-type: application/json' -H 'accept: application/json' -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'`
— you should get back a JSON `status: "tunnel"` with a `url`.

## Option B — Fly.io

```bash
cd deploy/cobalt
fly launch --copy-config --no-deploy          # choose an app name + region
fly secrets set API_URL="https://<your-app>.fly.dev/"
fly deploy
```
Set `COBALT_API_URL="https://<your-app>.fly.dev/"` in Vercel.

## Option C — Railway

New Project → **Deploy from Docker Image** → `ghcr.io/imputnet/cobalt:11`, expose port `9000`,
and add a variable `API_URL` = your Railway public URL (with trailing slash). Use that URL as
`COBALT_API_URL` in Vercel.

---

## Optional: require an API key

1. `cp keys.example.json keys.json` and replace the UUID with your own (`uuidgen`).
2. In `docker-compose.yml`, uncomment `API_KEY_URL` and the `keys.json` volume (or set the
   equivalent env on Fly/Railway).
3. Set `COBALT_API_KEY` in Vercel to that UUID.

This keeps random traffic off your instance. See the upstream docs for more:
<https://github.com/imputnet/cobalt/tree/main/docs>.
