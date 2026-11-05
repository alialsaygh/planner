# Planner — a phone-first, offline-first scheduling PWA

Everything runs in the browser. No account, no backend, no database server,
no build step. Upload this folder as-is to any free static host and open the
https link on your phone.

**Files**
- `index.html` — app shell
- `css/styles.css` — design (light/dark follows the system)
- `js/core.js` — helpers, Hijri date & Islamic key dates via `Intl` (no API)
- `js/data.js` — **DATA**: IndexedDB storage (+ localStorage fallback), seed, CRUD
- `js/scheduling.js` — **SCHEDULING**: deterministic engine + rule-based `interpret(text)` parser
- `js/calendar-links.js` — **NOTIFICATIONS/CALENDAR**: Google Calendar links, .ics, backups, sync codes, in-app reminders
- `js/ui.js` — **UI**: tabs, calendar views, sheets, Schedule Assistant
- `manifest.webmanifest`, `service-worker.js`, `icons/` — PWA install + full offline support

The only external requests are the two Google Fonts (Fraunces + Outfit);
system fonts are used as fallback and the service worker caches the fonts
after the first visit.

Test hook: open the app with `?mockdate=YYYY-MM-DD` to pretend "today" is
another date (used for automated week-rollover testing; harmless otherwise).

---

## Put it online for free (from a Windows PC), then install it on an iPhone

> ⚠️ **The only account needed anywhere:** step 1 below — a free GitHub
> account for the person who uploads the folder, created once. The app
> itself never asks anyone to sign up or log in.

### A. Upload (about 5 minutes, Windows, no software to install)

1. Go to **github.com** and create a free account (one-time; free plan is enough).
2. Click **＋ → New repository**. Name it `planner`, keep it **Public**, tick
   **Add a README**, click **Create repository**.
3. In the repository, click **Add file → Upload files**.
4. Open this `planner` folder in Windows File Explorer, press **Ctrl+A** to
   select everything **inside** it (including the `css`, `js` and `icons`
   folders), and **drag the selection into the browser window**. Folders keep
   their structure when dragged. Click **Commit changes**.
5. In the repository, go to **Settings → Pages** (left menu). Under
   *Build and deployment*, set **Source: Deploy from a branch**, Branch:
   **main**, folder **/(root)**, click **Save**.
6. Wait ~1 minute, refresh the Pages screen — it shows your link:
   `https://YOURNAME.github.io/planner/`
   (The app uses only relative URLs, so this subfolder address works fine.)

*Alternatives that work the same way: Netlify ("Deploy manually" — drag the
folder onto app.netlify.com/drop) or Cloudflare Pages. Also free, also one
account for the uploader only.*

### B. Open and install on the iPhone

1. Open **Safari** on the iPhone and visit the link from step A6.
2. Tap the **Share** button (the square with the up-arrow).
3. Scroll and tap **"Add to Home Screen"**, then **Add**.
4. Open **Planner from the Home Screen icon**. That's it — it now behaves
   like an app, works fully offline, and (important) iOS treats Home-Screen
   app storage as durable, so your data is safest this way.
5. On Android: open the link in Chrome → ⋮ menu → **Add to Home screen**
   (or the "Install app" prompt).

### C. What's free and what isn't

- Free forever: hosting (GitHub Pages / Netlify / Cloudflare free tiers),
  the fonts, the Hijri/Islamic dates (calculated on-device with `Intl`),
  the scheduler and assistant (pure JavaScript — no AI API, no key).
- Costs money (and is **not** needed): a custom domain name.
- Not possible without a server, stated honestly in the app: background
  push notifications. Instead, every event has **"Email me a reminder"**
  (prefilled Google Calendar link, repeat rule included) and **"Add to
  calendar"** (.ics download) so your phone's own calendar sends the alerts.

### D. Keeping your data safe

- Data lives on the device (IndexedDB, mirrored to localStorage), written on
  every change; the app asks the browser for persistent storage.
- **More → Backups**: Download / Share / Restore a JSON backup; a reminder
  appears every 14 days; the app silently keeps the **last 5 snapshots** so a
  bad import or a reset can be undone.
- **More → Sync**: move data between devices with an export/import code —
  no account involved.
