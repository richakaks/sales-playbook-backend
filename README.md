# Sales Playbook Capture Studio — backend

Small Express server with three jobs:

1. **Serves the interview tool itself** (`public/index.html`) as a normal webpage — employees get a link to click, not a file to download and "open with" a browser.
2. Holds the GLM (Z.ai) API key server-side and generates adaptive follow-up questions on request — so the key never has to live inside the HTML file.
3. Stores completed interview sessions in one place, so answers are visible across employees instead of stuck in each person's browser.

Because the app is served *by* this backend, it auto-detects its own backend URL — employees using the hosted link don't need to touch Settings at all. (If you instead download `public/index.html` and open it locally as a file, it won't auto-detect anything — that's expected, and Settings → Backend URL still works manually in that case.)

Storage is a plain JSON file (`data/sessions.json`), not a real database. That's a deliberate simplification to get something working on a free host today — see the caveat below, and the upgrade path once this is worth making permanent.

## Deploying to Render (free tier)

Render's free web services don't need a credit card, which is why this is set up for Render first. Two caveats worth knowing before you rely on this:

- **Cold starts.** Free services spin down after inactivity; the first request after a quiet period takes about a minute to wake back up. Fine for an internal tool, just don't be alarmed if the first load of the day is slow.
- **Storage isn't guaranteed to persist.** Render's free tier doesn't include a persistent disk, so `data/sessions.json` can get wiped when the service restarts or redeploys. This is fine for testing the pipeline end-to-end, but before this holds real employee data long-term, it should move to a real hosted database (Supabase and Turso both have generous free tiers and would be a small change from here — ask if you want that swapped in once this is proven out).

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

5. **Deploy.** Render gives you a URL like `https://sales-playbook-backend.onrender.com` — that URL is now the whole app. Send that link directly to employees; nothing to download or unzip.

6. **For Team Results** (Max seeing everyone's answers): open the app at that URL, go to Settings, and paste the `ADMIN_TOKEN` value into the Admin Token field — Backend URL fills itself in automatically since the page is served by the same backend.

7. Turn on "Use adaptive questions" once GLM account billing is resolved (currently blocked — see `../ADAPTIVE_QUESTIONS_SPEC.md`).

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
