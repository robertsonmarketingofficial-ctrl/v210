# Robertson Outreach CRM (v205)

Find leads, hold them, email them from 6 Gmail inboxes, read every reply in one place.

## Tabs
- **v210**: bounce check before every first email (dead domains, typos and placeholders skipped, never counted against your inbox), searches and hunts that run in the background and keep going across tabs and refreshes, several sweeps at once (e.g. tree service across SA and plumbers across NSW), spread-out pacing, and every sending, bounce, warmup and search rule editable in Settings.
- **Blocklist**: emergency services (SES, CFS, MFS), councils, government, schools, hospitals, churches and clubs are dropped from search results and never emailed. Add your own in Settings → Never email.
- **Live**: every email the moment it goes out ("Sent to …"), replies, bounces, failures, plus today's numbers and each inbox's progress
- **Dashboard**: today's sends vs capacity, replies waiting, funnel, inbox status
- **Lead Finder**: Google Maps search or full-state sweep, auto-finds emails on websites
- **AFK Hunter**: sweeps a state and queues every new lead with an email into a campaign
- **Pipeline**: every lead, filters, bulk add to campaign, CSV import/export
- **Campaigns**: multi-step sequences with {spintax|variations} and {{tokens}}
- **Inbox**: replies + bounces from all inboxes, reply in-thread from the same inbox
- **Inboxes & Warmup**: per-inbox mode (Warming / Active / Paused), caps, bounce rate, warmup health
- **Settings**: sending rules, background, Gmail + Places tests, one-file backup

## Setup (Vercel env vars)
| Variable | Example |
|---|---|
| `GMAIL_USERS` | `one@gmail.com,two@gmail.com,...` |
| `GMAIL_APP_PASSWORDS` | `abcd efgh ijkl mnop,...` (same order) |
| `GOOGLE_PLACES_API_KEY` | your Places key |
| `EMAIL_FROM_NAME` (optional) | `Callum Robertson` |

Each Gmail needs 2-Step Verification and an App Password. The same App Password is
used for sending (SMTP) and reading replies (IMAP). Redeploy after changing env vars.

## How sending works
The send engine runs in the browser while a CRM tab is open (only one tab runs it).
It sends one email at a time with a random gap (Settings, default 2-8 seconds),
rotates inboxes, caps each Active inbox at its own limit of cold emails per rolling 24h
(set per inbox when you press Start on a campaign, or on the Inboxes tab), respects
sending hours in the lead's own state, threads follow-ups from the same inbox, and
stops a lead's sequence on reply or bounce. New inboxes start in Warming mode and
send no cold email until you switch them to Active.

Data lives in browser localStorage. Back it up from Settings.

## Dev
    npm install
    npm run dev
    npm test
    npm run build

Node 20+.
