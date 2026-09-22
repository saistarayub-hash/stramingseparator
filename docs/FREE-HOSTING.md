# 🆓 Every free way to run StreamPilot 24/7 — the no-nonsense map

**What StreamPilot needs:** a long-running Node process (Express + SSE) with ~512MB+
RAM, FFmpeg for video processing, and *persistent disk* for uploads/clips (unless you
offload to Appwrite, which StreamPilot already does). Serverless/edge hosts **don't
qualify** — FFmpeg + video transcoding doesn't fit in request-bounded functions.

Verified against current (2026) vendor docs. Free tiers change fast; this is ranked by
**"how free + how little clicking back-and-forth"**, not by marketing.

---

## Ranked options

| # | Host | Free tier (2026) | Card? | Sleeps? | Disk | Verdict |
|---|---|---|---|---|---|---|
| 🥇 | **Oracle Always-Free VM** | 1–4 Arm VMs, 24/7, forever, up to 200 GB disk | Yes (identity, **not charged**) | ❌ never | ✅ real | **Best.** Raw compute + disk + never sleeps. Already scripted (`scripts/setup-vps.sh`). |
| 🥈 | **Northflank** | 2 always-on services + 1 DB + 2 cron jobs | Yes (verify only) | ❌ never | small/ephemeral | **Best PaaS.** Git-push deploy, no sleep. |
| 🥉 | **Koyeb** | 1 web service, 512MB / 0.1 vCPU / 2GB SSD, git deploys | Usually no (may ask to prove you're human) | ⚠️ scale-to-zero | 2 GB | Good one-box PaaS if you can't/won't use Oracle. |
| 4 | **Render** | 750 hrs/mo, 512MB | ❌ no | ⚠️ after 15 min idle | none (ephemeral) | Where you are now. Fine *if* you accept the sleep + external Appwrite storage. |
| 5 | **Hugging Face Spaces** | CPU 2 vCPU / 16 GB RAM | ❌ no | ⚠️ after 48h | ❌ ephemeral | NOT a general host — Docker Spaces now need a paid plan to *create*. Skip. |
| — | Railway / Zeabur / Fly.io | one-time credit only / no real free tier | varies | — | — | Not free-forever. Skip for this. |
| — | Vercel / Netlify / Cloudflare Workers | functions/edge only | ❌ no | n/a (serverless) | ❌ none | Can't run FFmpeg transcoding. Skip. |

---

## The one that ends the back-and-forth: Oracle Always-Free

The only option that is **free forever, never sleeps, has real disk, and needs no deploy
button ever again** — because it's *your own VM* you control via git+SSH.

Already in this repo, ready to go:

```bash
# 1. Oracle Cloud → always-free Arm VM (Ubuntu 22.04/24.04, any name) — one-time, ~10 min.
# 2. On the VM:
sudo -i
curl -fsSL https://raw.githubusercontent.com/saistarayub-hash/stramingseparator/arena/01a0ba1a-stramingseparator/scripts/setup-vps.sh -o /tmp/sp-setup.sh
bash /tmp/sp-setup.sh
# 3. optional free HTTPS at yourname.duckdns.org:
curl -fsSL https://raw.githubusercontent.com/saistarayub-hash/stramingseparator/arena/01a0ba1a-stramingseparator/scripts/setup-https.sh -o /tmp/sp-https.sh
bash /tmp/sp-https.sh
```

`setup-vps.sh` installs Node/FFmpeg, clones StreamPilot, wires Appwrite, starts it under
systemd (auto-restart on boot/crash), and keeps it updated. Full click-by-click in
`docs/DEPLOY-FREE.md`.

After that one-time setup, "deploy" = `git push` + `ssh vm 'cd streampilot && git pull && systemctl restart streampilot'`.
(A `DEPLOY_SSH_KEY` GitHub secret can even automate that, same as the Render key.)

---

## Northflank (if you'd rather stay on a PaaS, git-push style)

1. Sign up at northflank.com (card only to verify; not charged on the free Sandbox).
2. **New service → Deploy from GitHub** → pick this repo.
3. Set build command `npm ci --omit=dev`, start command `node server/index.js`, port `8787`.
4. Add env vars: `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_API_KEY` (+ YouTube keys later).
5. Free Sandbox keeps it **always-on** (no 15-min sleep like Render), 2 services included.

The repo's `.github/workflows/pipe.yml` already runs a post-push smoke test against any
`APP_URL`, so it slots in with zero code changes.

---

## Koyeb (no-card PaaS)

1. koyeb.com → sign in with GitHub → **Create Service → GitHub** → this repo.
2. Build: `npm ci --omit=dev` / run: `node server/index.js` / port `8787`, instance **free**.
3. Same Appwrite env vars. Accept it scales to zero (cold start ~10–20s).

---

## The honest bottom line

- **Anything host-based will still need ONE account sign-up from you** (I can't create
  accounts or enter cards for you — that's the only button that genuinely can't be automated).
- **Once that account exists, everything after is already automated**: the repo ships the
  Oracle setup script, a Dockerfile, `render.yaml` blueprint, the `pipe.yml` auto
  deploy+verify workflow, and a keep-warm job.
- **Right now, this instant**, StreamPilot is also running as a live sandbox preview —
  the dashboard is up and the upload→analyze→fix pipeline was verified end-to-end.
