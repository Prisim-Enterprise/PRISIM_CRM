# Product & architecture decisions

Tracks blueprint section 20 ("Open decisions") and what the build currently assumes.

| Question | Decision in this build | Status |
|---|---|---|
| Lead visibility | Employees can **view all leads, edit only their own**. Team Leaders edit their team's leads; Admins edit all. Configurable per role. | Confirmed |
| Calling method | **Click-to-call through a telephony provider** (Exotel adapter) with recording; manual logging and recording upload also available. Simulator until credentials are added. | Confirmed (provider account pending) |
| Hosting | Oracle Cloud Always Free Ampere VM running PostgreSQL + API + web in Docker. | Confirmed |
| Task scope | Tasks are general **and** can optionally link to a lead. | Assumed (blueprint recommendation) |
| Google Sheets format | One spreadsheet + tab, Meta Lead Ads default headers, mapping editable in the UI. | Assumed; confirm headers of the real sheet |
| Sync frequency | Every 5 minutes (configurable) + nightly full reconcile at 02:30 IST. | Assumed |
| Assignment policy | Manual by default; round-robin / workload available in bulk and as optional auto-assign on import. | Assumed |
| Conversion definition | A user sets status **Converted** (e.g. booking paid). Conversion rate = converted ÷ leads created in the period. | Assumed; confirm business event |
| Feedback anonymity | Allowed. Identity is not stored; only users with `feedback.view.all` see the inbox. | Assumed |
| Call recording | Enabled when the provider records. Playback limited to caller, their team leader, and admins; every play audited. Retention period still to be set. | Needs legal review |
| Tenancy | Single organisation (no `tenant_id`). | Assumed; must decide before any multi-company SaaS plans |
| Timezone | Asia/Kolkata for "today", reminders and reports. | Assumed |
