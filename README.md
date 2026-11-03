# Prisim CRM

One dashboard for Meta Ads leads, daily follow-ups, call tracking with recordings, Jira-style tasks, users and roles, and employee feedback and queries.

Built from the *Prisim CRM Business Workflow & Technical Architecture Blueprint v1.0*.

| Layer | Tech |
|---|---|
| Web | React 19 + TypeScript, Vite, Tailwind CSS, TanStack Query, Recharts |
| Auth | **FastAPI** (Python) service for sign-in, own profile and password changes, at `/api/v1/auth/*` (docs at `/api/v1/auth/docs`) |
| API | NestJS 11 (modular monolith) for everything else, REST `/api/v1`, Swagger at `/api/docs`. It verifies the tokens the auth service issues. |
| Database | PostgreSQL 17 + Prisma 6 |
| Integrations | Google Sheets API (service account), Exotel click-to-call + recordings, built-in call simulator |

## Run it locally (Windows / macOS / Linux)

Requires Node.js 20+ and Python 3.11+. A local PostgreSQL is downloaded and run for you.

```bash
npm install
cp .env.example .env        # then set JWT_SECRET etc. (already done on this machine)
npm run db:start            # terminal 1: local PostgreSQL on port 5433
npm run db:migrate          # first time only
npm run db:seed -- --demo   # first time only: roles + admin + sample data
npm run setup:auth          # first time only: Python venv for the auth service
npm run dev:auth            # terminal 4: auth service on http://localhost:4100
npm run dev:api             # terminal 2: API on http://localhost:4000
npm run dev:web             # terminal 3: app on http://localhost:5173
```

Or run everything together with `npm run dev` (database, auth, API, web).

> npm 11 blocks package install scripts by default. If `prisma generate` complains, run
> `npm approve-scripts @prisma/engines esbuild` once, then `npm rebuild`.

### Demo logins (from `--demo` seed)

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@prisim.local | Admin@12345 |
| Admin / Manager | manager@prisim.local | Demo@12345 |
| Team Leader (North) | lead.north@prisim.local | Demo@12345 |
| Team Leader (South) | lead.south@prisim.local | Demo@12345 |
| Employee | rahul@prisim.local, priya@prisim.local, karthik@prisim.local, sneha@prisim.local | Demo@12345 |

Without `--demo`, the seed creates only the Super Admin and prints a random password.

To remove all data (leads, calls, follow-ups, tasks, feedback, logs, all users except Super Admins, and teams) while keeping roles and permissions:

```bash
npm run clear-data -w apps/api
```

Uploaded files and recordings are stored in `storage/`. Delete that folder's contents to remove them too.

## What's included

**Leads (Modules A + B).** Google Sheets sync every N minutes. It reads only new rows (cursor), normalises Meta phone and date formats, validates rows, deduplicates on the Meta lead ID, flags the same phone number arriving again as a *Duplicate* linked to the original lead, and logs every rejected row so it can be retried. It never overwrites fields a user has edited. It also runs a nightly full reconciliation, and CSV import is available as a fallback. Leads can be assigned manually, in bulk, round-robin or by workload, or auto-assigned on import, with full assignment history. The lead lifecycle uses controlled status transitions with a reason for each change.

**Follow-ups (Module C).** Today / Overdue / Upcoming / Completed views. Reminders go out 15 minutes before a follow-up is due and again when it becomes overdue. Reschedule history is kept. Completing a follow-up requires either the next action or closing the lead with a reason, so leads are never closed by accident.

**Calls (Module D).** Click-to-call through Exotel: it rings the employee's phone, then the customer, and records the call. Status, duration and recording arrive by an authenticated webhook, and recordings are copied into private storage. Calls can also be logged manually, with an uploaded recording. The Calls page shows who called whom, when, for how long, the outcome and the recording. Recordings play only for the caller, their team leader, or admins, and every play is audited. Until Exotel is configured, a **simulator** exercises the whole flow.

**Tasks (Module E).** Kanban board (drag and drop) and list view. Tasks have keys (PRS-12), priorities, due dates, subtasks, checklists, comments, attachments and an activity history. They can be linked to a lead, and there is an optional manager review/approval step. Overdue tasks trigger reminders.

**Feedback & Queries (Module F).** Employees can raise queries and give feedback, by category and urgency, with attachments. In **anonymous mode** the submitter's identity is never stored: not in the record, the audit log, the notifications or the attachment metadata. The submitter can still follow replies through a keyed hash. The admin inbox supports owners, statuses, threaded replies and internal notes.

**Clients.** The Super Admin adds clients (contact, notes, status) and posts pieces of work for a client to one or more people, with priority, due date and brief. The people it's posted to get a notification, post progress updates and files, and move it to *Submitted*; the Super Admin marks it *Done*. Employees only see work posted to them. Admins see every client, work item and update (`clients.view.all`) and are notified when someone posts an update; posting work needs `clients.manage`, which only the Super Admin has by default and which can be granted per user under Roles & Permissions.

**Website leads and the lead webhook.** Integrations has a separate *Website leads* Google Sheet connection (source "Website"), next to Meta Ads. A sheet shared as "Anyone with the link → Viewer" is read without any Google credentials; common headers (Name, Phone/Mobile, Email, City, Timestamp…) are detected automatically and extra columns such as Message are shown on the lead. The *Lead webhook* tab gives a secret URL (`POST /api/v1/webhooks/leads?key=…&source=website`) that other software can post leads to as JSON or form fields; repeats don't create duplicates. The dashboard shows website leads, leads by source and the latest website leads.

**Activity feed.** The dashboard shows a live feed of who did what: lead status changes, assignments, notes, calls, follow-ups, task changes, feedback and client work updates. Admins see everyone, team leaders see their team and employees see their own. Anonymous feedback is never attributed.

**Users & roles.** Super Admin, Admin/Manager, Team Leader and Employee are editable permission bundles (30 permissions), and custom roles can be added. The backend enforces every scope (all / team / own). Employees can **view all leads but only edit their own**, as decided.

**Dashboard & reports (Module G).** Metrics, daily trends, lead status, campaign performance, call outcomes and per-employee performance, scoped by role, with date, campaign, team and employee filters. Metric definitions are documented in `apps/api/src/reports/reports.ts`.

**Platform.** In-app notifications, audit log, rate limiting, security headers, validated inputs, CSV export (protected against formula injection) and private file storage.

## Tests

```bash
npm test                  # API unit tests + auth service tests (pytest)
```

An end-to-end API check covering roles and permissions, assignment, calls, recordings, tasks, anonymous feedback and import was run during development (59 checks, all passing).

## Project layout

```
apps/auth     FastAPI auth service (sign-in, own profile, password)
apps/api      NestJS API (src/<module>), Prisma schema + migrations + seed
apps/web      React app (src/pages, src/components)
infrastructure Dockerfiles + Caddyfile for production
scripts       local database runner, backup script
docs          deployment guide, decisions
```

## Deploying

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (Oracle Cloud Always Free).

## How sign-in works

1. The web app posts email + password to `/api/v1/auth/login`, which goes to the **FastAPI** service.
2. FastAPI checks the bcrypt password hash in PostgreSQL, applies a limit of 10 attempts per minute per IP, writes to the audit log, and returns a signed token (HS256, valid 12h).
3. All other requests go to the **NestJS** API, which verifies the same token with the shared `JWT_SECRET`. It reloads the user's roles and permissions on every request, so deactivating a user or changing their role takes effect immediately.
4. Admins still create users and reset passwords in the NestJS API, and both services use the same bcrypt format.
