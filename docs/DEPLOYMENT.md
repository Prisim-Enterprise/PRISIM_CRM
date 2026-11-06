# Deploying Prisim CRM on Oracle Cloud (Always Free)

The whole stack runs on one free **Ampere A1** VM: PostgreSQL, the NestJS API, and the web app behind Caddy, which handles HTTPS automatically and routes `/api/v1/auth/*` to the auth service.

> **Why not Oracle Autonomous Database?** It's Oracle SQL. Prisma (and this schema) target PostgreSQL. The free A1 VM (up to 4 OCPU / 24 GB RAM / 200 GB disk) runs PostgreSQL comfortably for this workload.

## 1. Create the VM

1. Oracle Cloud Console → **Compute → Instances → Create instance**.
2. Image: **Ubuntu 24.04**. Shape: **VM.Standard.A1.Flex** (e.g. 2 OCPU, 12 GB). Add your SSH key.
3. After creation, open the VCN's **Security List** and add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.
4. On the VM, also open the OS firewall (Ubuntu images ship with iptables rules):
   ```bash
   sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
5. Point a DNS record (e.g. `crm.yourcompany.in`) at the VM's public IP.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

## 3. Deploy

```bash
sudo mkdir -p /opt/prisim-crm && sudo chown $USER /opt/prisim-crm
# copy the project here (git clone, or scp the folder without node_modules/.pgdata/storage)
cd /opt/prisim-crm
cp .env.example .env
nano .env
```

Set at least these in `.env`:

```
NODE_ENV=production
DOMAIN=crm.yourcompany.in
POSTGRES_PASSWORD=<long random>
VITE_CLERK_PUBLISHABLE_KEY=<from Clerk>
CLERK_SECRET_KEY=<from Clerk>
FEEDBACK_HASH_SECRET=<random>             # never change it after go-live
WEB_ORIGIN=https://crm.yourcompany.in
PUBLIC_API_URL=https://crm.yourcompany.in
TELEPHONY_WEBHOOK_SECRET=<random>
SEED_ADMIN_EMAIL=you@yourcompany.in
```

`DATABASE_URL` is set by the compose file. You don't need it in `.env` on the server.

```bash
docker compose -f docker-compose.prod.yml up -d --build
# first time only: roles, permissions and your Super Admin
docker compose -f docker-compose.prod.yml exec api npx ts-node --transpile-only prisma/seed.ts
```

Open `https://crm.yourcompany.in` and sign in. Caddy gets the certificate on first request.

## 4. Connect Google Sheets (Meta Ads leads)

1. Google Cloud Console → new project → enable **Google Sheets API**.
2. **IAM → Service Accounts → Create**, then **Keys → Add key → JSON**.
3. `base64 -w0 key.json` and put the output in `.env` as `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=...`, then `docker compose -f docker-compose.prod.yml up -d api`.
4. In the leads spreadsheet: **Share** → the service account email → **Viewer**.
5. In the CRM: **Integrations → Google Sheets setup**. Paste the sheet URL, tab name, check the column mapping, **Save & test connection**, enable auto-sync.

Meta Lead Ads → Google Sheets is usually connected with Meta's native integration or a connector (e.g. Zapier/Make/LeadsBridge). Keep Meta's `id` column: it is the deduplication key.

## 5. Connect Exotel (click-to-call + recordings)

1. Exotel account → buy an ExoPhone, enable call recording, and note the **SID, API key, API token** and subdomain (`api.exotel.com`, or `api.in.exotel.com` for the Mumbai cluster).
2. In `.env`: `TELEPHONY_PROVIDER=exotel`, `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`, `EXOTEL_CALLER_ID`.
3. `PUBLIC_API_URL` must be the public HTTPS address. Exotel posts call results to `/api/v1/telephony/webhooks/exotel?token=…`.
4. Restart: `docker compose -f docker-compose.prod.yml up -d api`.
5. Every employee needs a phone number on their profile, because Exotel rings that number first.

**Compliance:** call recording in India requires informing the customer (e.g. an IVR "this call may be recorded" announcement), a defined retention period, and restricted access. Access is already restricted in the CRM. Agree the retention period with your legal advisor before go-live.

## 6. Backups

```bash
chmod +x scripts/backup.sh
crontab -e
# 30 1 * * * /opt/prisim-crm/scripts/backup.sh >> /var/log/prisim-backup.log 2>&1
```

Copy `/opt/prisim-backups` off the VM regularly (e.g. to OCI Object Storage, which includes 20 GB free). Practise a restore every quarter (command at the bottom of the script).

## 7. Updating

```bash
cd /opt/prisim-crm && git pull     # or copy the new files
docker compose -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically when the API container starts.

## Health and logs

- `https://crm.yourcompany.in/health` returns `{"status":"ok"}` when the API and database are up.
- `docker compose -f docker-compose.prod.yml logs -f api`
