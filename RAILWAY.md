# Going Live With SAFE_Links on Railway

An alternative to `DEPLOYMENT.md`'s VPS path. No server to rent, no
`docker compose up` to run yourself — Railway builds `web-app/backend`
and `web-app/frontend` straight from this GitHub repo and gives you a
managed Postgres database.

You're creating **one Railway project with three services**: a
Postgres database, the backend API, and the frontend. This guide only
covers `web-app/` — the Android and Windows apps still need a live web
app first (same as `DEPLOYMENT.md` explains), then point at whatever
domain Railway gives your frontend service.

---

## Part 0 — Push this repo to GitHub

If you haven't already:

```bash
cd safe-links
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

(Create the empty repo on GitHub first at github.com/new, don't
initialize it with a README — then the commands above will push
cleanly.)

✅ **Checkpoint:** refreshing your GitHub repo page shows all the
folders — `web-app/`, `android-app/`, `desktop-app/`, `system-demo/`,
`tools/`.

---

## Part 1 — Create the Railway project + Postgres

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick your repo.
2. Railway will try to auto-detect a service from the repo root — **delete that first auto-created service** (click it → Settings → Delete Service). You'll add the three real services manually so each one points at the right subfolder.
3. In the now-empty project, click **+ New** → **Database** → **Add PostgreSQL**.

✅ **Checkpoint:** your project canvas shows one Postgres service, already running.

---

## Part 2 — Add the backend service

1. **+ New** → **GitHub Repo** → same repo again.
2. Click the new service → **Settings**:
   - **Root Directory**: `web-app/backend`
   - **Build**: leave as "Dockerfile" (Railway auto-detects `web-app/backend/Dockerfile`)
3. **Variables** tab — add these:

```
JWT_SECRET=
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Generate a real `JWT_SECRET` value on your own machine and paste it in:

```bash
openssl rand -hex 32
```

`${{Postgres.DATABASE_URL}}` is a Railway variable reference — type it
exactly like that; Railway resolves it to your Postgres service's real
connection string automatically, including after credentials rotate.

Optional (email — leave unset to use the in-app manual-notification
fallback instead):

```
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=SAFE_Links <no-reply@yourdomain.com>
```

4. **Settings → Networking → Generate Domain** — gives you a public
   URL like `https://backend-production-xxxx.up.railway.app`. Copy it,
   you need it in Part 3.

5. **Add a Volume** (this is required — without it, every uploaded
   receipt/support-ticket attachment is silently deleted on the
   backend's next deploy or restart, since Railway containers don't
   keep local disk changes): **Settings → Volumes → New Volume** →
   mount path:

```
/app/uploads
```

✅ **Checkpoint:** the backend service shows a green "Active" deploy.
Open `https://YOUR-BACKEND-DOMAIN/health` in a browser — it should
return `{"ok":true,"service":"safe-links-backend"}`.

---

## Part 3 — Add the frontend service

1. **+ New** → **GitHub Repo** → same repo again.
2. **Settings**:
   - **Root Directory**: `web-app/frontend`
   - **Build**: leave as "Dockerfile"
3. **Variables** tab:

```
VITE_API_URL=https://YOUR-BACKEND-DOMAIN
```

Use the real backend domain you copied in Part 2, no trailing slash.

⚠️ **This one is a build-time value, not a runtime one** — Vite bakes
it into the compiled JS during `npm run build`. If you set or change
it *after* the first deploy, click **Deploy → Redeploy** on the
frontend service afterward, or the old value stays baked into the
build the browser downloads.

4. **Settings → Networking → Generate Domain** for the frontend too.

✅ **Checkpoint:** open the frontend's Railway domain in a browser —
the SAFE_Links login/signup screen loads, and creating an account
actually reaches the backend (check the browser's Network tab for
`200` responses, not CORS or connection errors).

---

## Part 4 — Point everything at a real domain (optional)

Railway's own `*.up.railway.app` domains work fine to start. To use
your own domain instead: on the frontend service, **Settings →
Networking → Custom Domain**, add e.g. `app.yourdomain.com`, then add
the CNAME record Railway shows you at your domain registrar. Repeat
for the backend on a subdomain like `api.yourdomain.com` if you want
one — then update `VITE_API_URL` on the frontend to match and
redeploy.

---

## Notes specific to this setup

- **Same repo, three services, three "Root Directory" settings** —
  this is how one GitHub repo becomes three independent Railway
  deploys. Pushing to `main` redeploys all three automatically;
  Railway only rebuilds a service when a file under its Root Directory
  actually changed.
- **CORS**: the backend already sends
  `Access-Control-Allow-Origin: *`, so the frontend and backend living
  on two different Railway domains works without any code change.
- **The frontend's nginx `/api/` and `/uploads/` proxy blocks
  (`web-app/frontend/nginx.conf.template`) are dead code in this
  specific setup** — they only matter when frontend and backend share
  one domain (the VPS/Docker Compose path in `DEPLOYMENT.md`). On
  Railway, the browser calls the backend's own domain directly via
  `VITE_API_URL`, bypassing them entirely. Harmless either way, just
  worth knowing they're not doing anything here.
- **Database schema**: the backend creates its own tables on first
  boot (see `web-app/backend/src/db.js`) — nothing to run manually.
- **Costs**: Railway's free tier has usage limits that a Postgres +
  two always-on services will likely exceed within the trial; check
  Railway's current pricing before committing to it for a real launch.
