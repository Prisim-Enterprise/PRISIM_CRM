# Deploying on Vercel and Supabase

Vercel serves the web app and runs the backend as one function (`api/index.js`). Supabase holds
the database and uploaded files, and triggers scheduled jobs once a minute.

```
Browser ──► Vercel ──► web app (frontend/dist)
               └─/api─► function (backend) ──► Supabase database + file storage
Supabase pg_cron ──every minute──► /api/v1/internal/tick
```

## Environment variables on Vercel

| Name | Value |
|---|---|
| `DATABASE_URL` | Transaction pooler string, port **6543**, ending `?sslmode=require&pgbouncer=true&connection_limit=3` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase secret key (`sb_secret_...`) |
| `CLERK_SECRET_KEY` | Clerk production secret key (`sk_live_...`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk production publishable key (`pk_live_...`) |
| `WEB_ORIGIN` | `https://crm.prisim.co.in` |
| `PUBLIC_API_URL` | `https://crm.prisim.co.in` |
| `CRON_SECRET` | Long random value, the same as in local `.env` |
| `FEEDBACK_HASH_SECRET` | Same value as local `.env`, so anonymous feedback stays anonymous and consistent |
| `APP_TIMEZONE` | `Asia/Kolkata` |
| `DEFAULT_COUNTRY` | `IN` |

## After the first deploy

Set `PUBLIC_API_URL` in local `.env` to the live address, then run `npm run supabase:setup`.
It creates the private `crm-files` bucket and the once-a-minute job trigger. It is safe to run again.

Schema changes are not applied by Vercel. Run `npm run prisma:deploy -w backend` locally with
`DATABASE_URL` set to the Session pooler (port 5432).

## Limits

- Files over 3 MB go from the browser straight to Supabase, because Vercel limits a request to about 4.5 MB. The upload limit is 25 MB.
- Vercel also limits a reply to about 4.5 MB, which affects very large CSV exports from the Leads page.
- A function stops after 60 seconds, so a very large CSV import or sheet re-read may need splitting.
- The mock telephony provider relies on timers, which do not run once a function has replied. Use a real provider in production.
