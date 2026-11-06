# Hosting on your PC with Vercel in front

The team opens the Vercel address. Vercel serves the web app and forwards every `/api/...`
request through an ngrok tunnel to this PC, where the API runs.

```
Browser ──► Vercel (web app) ──/api──► ngrok ──► API :4000 ──► database
```

## One-time setup

1. **ngrok**: create a free account at https://dashboard.ngrok.com, then in a terminal run
   `ngrok config add-authtoken <your token>` (from *Your Authtoken*). Under *Domains*, claim
   your free static domain (e.g. `prisim-crm.ngrok-free.app`).
2. In `.env` set `NGROK_DOMAIN`, `TRUST_PROXY_HOPS=2`.
3. In `vercel.json` replace `NGROK_DOMAIN` in the `/api` rewrite with your domain. Commit and push.
4. **Vercel**: *Add New → Project*, import the GitHub repo, keep *Root Directory* as the repo root
   (settings come from `vercel.json`) and deploy.
5. In `.env` set `PUBLIC_API_URL` to the Vercel address (so the lead webhook URL is correct)
   and `WEB_ORIGIN` to include it.
6. In Vercel, add the environment variable `VITE_CLERK_PUBLISHABLE_KEY`.

## Running it

`npm run serve` starts the database, API (production build) and tunnel.
Keep the PC on and awake (Windows: Settings → Power → Sleep: Never). To start it automatically
at login, add a Task Scheduler task that runs `npm run serve` in the project folder.
