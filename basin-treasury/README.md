# Basin // Treasury Vault

A private, 2-person, 5-week rolling cash flow forecast + daily treasury tool for
Basin Engineering & Surveying. Static front end + Netlify Functions backend,
synced live between Nick and Joel's browsers via Netlify Blobs.

## What's in here

```
public/               the whole front end (static, no build step)
  index.html
  styles.css
  js/                  state engine, NetSuite import parser, views, sync client
netlify/functions/     the tiny API: login, get/save shared state, version history
netlify.toml
package.json
```

## 1. Deploy to Netlify

**Easiest path — GitHub:**
1. Push this folder to a new GitHub repo (private is fine).
2. In Netlify: **Add new site → Import an existing project → GitHub** → pick the repo.
3. Build settings are already set via `netlify.toml` (publish = `public`, functions = `netlify/functions`) — just click **Deploy**.

**Or via CLI**, from inside this folder:
```
npm install -g netlify-cli
netlify login
netlify init
netlify deploy --prod
```

Netlify Blobs (the shared database) needs no setup — it's automatically
available to any site once deployed on Netlify.

## 2. Set your environment variables

In Netlify: **Site configuration → Environment variables**, add:

| Key | Value |
|---|---|
| `NICK_PASSWORD` | a password for Nick (editor) |
| `JOEL_PASSWORD` | a password for Joel (editor) |
| `WES_PASSWORD` | a password for Wes (view only) |
| `DANIEL_PASSWORD` | a password for Daniel (view only) |
| `ERIC_PASSWORD` | a password for Eric (view only) |
| `SESSION_SECRET` | any long random string (e.g. run `openssl rand -hex 32`) |

Wes, Daniel, and Eric can log in and see everything — the full forecast, AR/AP,
fixed payments, settings — but every control that changes data is disabled for
them, and the backend rejects any save attempt from their accounts even if
someone tried to force it, so it's enforced server-side, not just hidden in
the UI.

Redeploy (or trigger **Clear cache and deploy site**) after adding these so the
functions pick them up. You can change either password any time in this
settings screen — no code changes needed.

## 3. Log in

Visit your Netlify URL, pick **Nick** or **Joel** from the dropdown, enter the
password you set above. Sessions last 21 days.

## Importing from NetSuite

Run the standard **A/R Aging Detail** or **A/P Aging Detail** report in
NetSuite and export it — **.xlsx**, **.xml** (NetSuite's Excel-XML export),
or a **.csv** with the same column headers all work. Use **Import Aged AR** /
**Import Aged AP** on the respective tab.

Behavior on import:
- Existing invoices (matched by customer/vendor + invoice # + date) get their
  balance, due date, and age refreshed — any CF date or pay-run assignment
  you've already set is **preserved**.
- New invoices are added as open, and auto-scheduled immediately if that
  customer/vendor has an auto-schedule template turned on (Settings tab).
- Anything that was previously open but is missing from the new export is
  assumed collected/paid and flagged **Paid** automatically.
- Retainage is intentionally not tracked — those columns are left out.

## Auto-scheduling

Settings → **Customer Auto-Schedule** / **Vendor Auto-Schedule**: set a
"days from invoice date" and flip the toggle on. New imports for that
customer/vendor will auto-assign a CF date going forward. Use **Apply** next
to any row to instantly recalculate the CF date on every currently-open
invoice for that customer/vendor. You can always override an individual
invoice's date by hand on the Receivables/Payables tab — auto-schedule never
overrides a date you didn't ask it to.

## Daily treasury management

Every number on the **CF Forecast** grid — Receivables Collected, Other
Inflows, each manual outflow line, each fixed-payment group, the weekly AP
total, LOC draws — starts out computed from your Receivables/Payables/Fixed
Payments data, but is click-to-edit. A small brass dot marks a cell you've
manually overridden. That's the mechanism for reflecting reality as it
diverges from the original forecast during the week without having to move
every underlying invoice. Click the cell and clear it to fall back to the
computed value.

## Payroll

Payroll moved out of the manual weekly-entry list and is now set once, when
you create a new forecast period (Settings → **+ New Period**): opening cash,
opening LOC balance, the payroll amount (as a positive number — it posts as
an outflow), and which of the 5 weeks the first pay run falls in. Since
payroll is biweekly, the app automatically figures out the other week(s) in
that same period that also get a payroll outflow of the same amount. You can
still fine-tune any individual week (or all 5 at once) directly on the
Payroll row of the CF Forecast grid, exactly like any other fixed-payment row.

## Sync between Nick and Joel

Every edit auto-saves ~1.5s after you stop typing. The app also polls for the
other person's changes every 20 seconds and on window focus — if you have
unsaved edits in flight it won't clobber them. **Save Version** forces an
immediate push and snapshot. Settings → **Version History** keeps the last 3
saves and lets you restore any of them.

Every override on the CF Forecast grid, and every manual edit on Receivables,
Payables, and Fixed Payments, is stamped with the initial of whoever made it —
a small brass badge (N or J) sits right on the cell or row so you can always
tell who changed what.

## Local development

```
npm install -g netlify-cli
netlify dev
```

This serves the site and functions locally. Netlify Blobs requires a linked
site (`netlify link`) even in dev mode.
