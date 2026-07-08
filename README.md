# Sales Playbook Capture Studio — backend

Small Express server with three jobs:

1. **Serves the interview tool itself** (`public/index.html`) as a normal webpage — employees get a link to click, not a file to download and "open with" a browser.
2. Holds the GLM (Z.ai) API key server-side and generates adaptive follow-up questions on request — so the key never has to live inside the HTML file.
3. Stores completed interview sessions in one place, so answers are visible across employees instead of stuck in each person's browser.

Because the app is served *by* this backend, it auto-detects its own backend URL — employees using the hosted link don't need to touch Settings at all. (If you instead download `public/index.html` and open it locally as a file, it won't auto-detect anything — that's expected, and Settings → Backend URL still works manually in that case.)

Storage is a real hosted database (Turso) once you set it up per the "Persistent storage" section below — before that, it falls back to a plain JSON file (`data/sessions.json`) that Render can (and did, in practice) wipe on restart or redeploy. Set up Turso before trusting this with real employee data.

## Deploying to Render (free tier)

Render's free web services don't need a credit card, which is why this is set up for Render first. Two caveats worth knowing before you rely on this:

- **Cold starts.** Free services spin down after inactivity; the first request after a quiet period takes about a minute to wake back up. Fine for an internal tool, just don't be alarmed if the first load of the day is slow.
- **Storage isn't guaranteed to persist unless Turso is set up.** Render's free tier doesn't include a persistent disk, so without Turso configured, `data/sessions.json` can get wiped when the service restarts or redeploys — this actually happened once already. Set up Turso (below) before this holds anything you can't afford to lose.

### Steps

1. **Push this folder to a GitHub repo.** From inside `sales-playbook-backend/`:
   ```
   git init
   git add .
   git commit -m "Sales playbook backend"
   ```
   Then create a new empty repo on GitHub (github.com/new) and follow the "push an existing repository" instructions it gives you.

2. **Create a Render account** at render.com (no credit card needed for the free tier) and connect your GitHub account.

3. **New → Web Service**, pick the repo you just pushed.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free

4. **Set environment variables** in Render's dashboard (Environment tab) — do not commit these to GitHub:
   - `GLM_API_KEY` — the key First gave you
   - `GLM_MODEL` — `glm-4.6` is confirmed valid; can be changed to any model in Z.ai's current lineup
   - `GLM_BASE_URL` — `https://api.z.ai/api/paas/v4/chat/completions` (confirmed correct against Z.ai's own API docs)
   - `ADMIN_TOKEN` — make up any password-like string yourself; this protects the endpoint that lists everyone's answers
   - `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` — see "Persistent storage" below. Without these, saved sessions can be wiped on the next redeploy.

5. **Deploy.** Render gives you a URL like `https://sales-playbook-backend.onrender.com` — that URL is now the whole app. Send that link directly to employees; nothing to download or unzip.

6. **For Team Results** (Max seeing everyone's answers): open the app with `?admin=1` on the end of the URL, e.g. `https://sales-playbook-backend.onrender.com/?admin=1`. This reveals a "Team Results" tab and a Settings card for Backend URL / Admin Token that regular employees never see (the plain link, with no `?admin=1`, hides all of that — employees only ever see Interview / My Sessions / My Knowledge / Settings-with-just-name-and-privacy). Paste the `ADMIN_TOKEN` value into the Admin Token field; Backend URL fills itself in automatically.
   - Note: `?admin=1` is just a UX convenience to keep the everyday screen uncluttered, not real security — the actual protection is the `ADMIN_TOKEN` check on the server. Don't rely on the hidden URL alone to keep data private.

7. Adaptive questions are on by default now — no toggle to flip. If GLM is ever down or the account hits a billing issue, it silently falls back to the standard scripted questions, so employees are never blocked.

## Persistent storage (Turso) — do this before trusting this with real data

Without this, session data lives in a JSON file on Render's disk, which is not guaranteed to survive a restart or redeploy (this already happened once). Turso is a hosted SQLite-compatible database with a generous free tier and no credit card required. Setup is entirely through their web dashboard — no command line needed.

1. Go to **turso.tech** and sign up (GitHub or Google login both work).
2. In the dashboard, **create a new database** — any name is fine, e.g. `sales-playbook`. Pick the region closest to you/Render.
3. Once created, open the database and find the **Connect** (or **Settings**) tab. You need two values from there:
   - The **database URL** — starts with `libsql://...`. This is `TURSO_DATABASE_URL`.
   - An **auth token** — the dashboard has a button to generate one (sometimes labeled "Create Token" or similar). This is `TURSO_AUTH_TOKEN`. Treat it like a password — don't share it or commit it to GitHub.
4. In Render, go to your service → **Environment**, and add both:
   - `TURSO_DATABASE_URL` = the `libsql://...` URL
   - `TURSO_AUTH_TOKEN` = the token you generated
5. Save — Render will redeploy automatically. Check the deploy logs (or `/health`) after it comes back up; the server logs `Session storage: Turso (persistent)` on startup once it's picked up correctly. If those two variables aren't set, it logs a warning instead and keeps using the local file (same old risk).
6. The very first session saved after this creates the table automatically — nothing else to configure.

Once this is live, sessions survive redeploys, restarts, and Render spinning the service down for inactivity — the only way to lose them is deleting the Turso database itself.

### Updating the deployed app later

If you edit `sales_playbook_capture_studio.html` at the project root, copy it into `sales-playbook-backend/public/index.html` before committing, then push — Render redeploys automatically on every push to `main`:
```
cp ../sales_playbook_capture_studio.html public/index.html
git add .
git commit -m "Update frontend"
git push
```

## Testing locally before deploying

```
npm install
cp .env.example .env   # fill in GLM_API_KEY and ADMIN_TOKEN
npm start
```

Then check `http://localhost:3000/health` returns `{"ok":true,...}`.

## Endpoints

- `GET /health` — status check
- `POST /api/sessions` — save a completed interview session (called automatically by the app when privacy isn't "Keep private")
- `GET /api/sessions` — list every saved session (requires header `x-admin-token`)
- `DELETE /api/sessions/:id` — remove a session (requires `x-admin-token`)
- `POST /api/generate-question` — generates the next adaptive question from GLM given the persona, stage backlog, and transcript so far (see `../ADAPTIVE_QUESTIONS_SPEC.md`)
