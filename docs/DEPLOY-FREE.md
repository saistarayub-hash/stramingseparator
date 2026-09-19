# 🆓 Deploy StreamPilot free & always-on — the full guide

This walks you from nothing to a **permanent, $0, never-sleeping** StreamPilot at
`https://your-name.duckdns.org`.

The only hard part is Oracle's sign-up — everything after that is two commands.

You need ~25 minutes, a credit card (for identity checks, **not charged**), and any computer
with a terminal.

---

## Step 0 — what you'll have

```
[Oracle Always-Free VM: 200GB disk, 24/7, $0]
   └─ StreamPilot (Docker)        ← your app, auto-restarts
        ├─ http://<ip>:8787       ← works immediately
        └─ https://yourname.duckdns.org   ← after step 4 (free TLS)
             └─ Appwrite cloud    ← stores videos + settings
```

---

## Step 1 — sign up for Oracle Cloud

1. Go to <https://signup.cloud.oracle.com>
2. Fill in your details, **Home region: pick the closest one available** (e.g. Johannesburg).
3. Verify phone + email, and give a card for identity verification. **You are not charged**
   for Always-Free resources.
4. Wait for the "welcome" email (~2–20 minutes).

---

## Step 2 — create the free VM

1. In the Oracle console, search **`Instances`** → **Create instance**.
2. Name it `streampilot`.
3. **Image:** keep *Ubuntu 22.04 (or 24.04)*.
4. **Shape — this is the important part:**
   - Click **Change shape** → the **Specialty and legacy** or **Ampere** tab.
   - Pick **VM.Standard.A1.Flex** (ARM).
   - Set **OCPUs: 2**, **Memory: 12 GB** (that's the sweet spot — free budget is 4 OCPU / 24 GB total; 2×12 leaves room for tweaks).
     - *If A1 is greyed-out / "out of capacity":* try again later in another availability domain, or use the **VM.Standard.E2.1.Micro** (1 OCPU / 1 GB, also free) — it runs StreamPilot fine, just a little snug for big Whisper captions.
5. **Boot volume:** keep 100 GB (free budget is 200 GB).
6. **SSH keys:** click **Generate key pair** and **download the PRIVATE key** (`ssh-key-…key`). Guard it.
   *(Alternative: paste your own public key.)*
7. **Create.** Wait for the instance state to turn **RUNNING**.
8. Copy its **Public IP address** — that's your server.

---

## Step 3 — fire the one-command installer

From your computer's terminal (replace the path with where your `.key` downloaded):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC-IP>
```

Once you're logged in as `ubuntu`:

```bash
sudo -i                          # become root

curl -fsSL https://raw.githubusercontent.com/saistarayub-hash/stramingseparator/arena/01a0ba1a-stramingseparator/scripts/setup-vps.sh -o /tmp/sp-setup.sh
bash /tmp/sp-setup.sh
```

It prompts for two things (paste them):

| Prompt | Value |
|---|---|
| **Appwrite Project ID** | `6aaeab640039b9e4c8eb` |
| **Appwrite API key** | your `standard_…` key |

Then Docker builds the app (a few minutes) and prints:

```
✅ StreamPilot is live (free + always-on).
   Open:  http://<PUBLIC-IP>:8787
```

Open that URL in a browser — **the app is already live, and on first boot it auto-created
your Appwrite database, collections, and storage bucket.** 🎉

> **First boot's schema creation:** the app connects to your Appwrite project and creates
> `streampilot` database → `videos` / `publishes` / `settings` collections → `videos` bucket.
> You can verify anytime with:
> `cd /opt/streampilot && npm run cloudcheck` (…or `docker compose exec streampilot npm run cloudcheck`).

---

## Step 4 — free HTTPS + your own domain (DuckDNS + Caddy)

So it's reachable at a nice, permanent `https://` address (and the **YouTube Connect** button
works off your public link):

1. **Get a free subdomain:** go to <https://www.duckdns.org>, sign in with Google/GitHub,
   create a subdomain (e.g. `mystream`), note the **token** it shows.
2. **Open the network ports:** in Oracle console → your VM's **Virtual Cloud Network** →
   **Security List** → **Add Ingress Rules**:
   - `0.0.0.0/0` TCP **80**
   - `0.0.0.0/0` TCP **443**
   - (optional) `0.0.0.0/0` TCP **8787** if you also want direct access without the domain.
3. **Run the HTTPS installer** on the VM:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/saistarayub-hash/stramingseparator/arena/01a0ba1a-stramingseparator/scripts/setup-https.sh -o /tmp/sp-https.sh
   bash /tmp/sp-https.sh
   ```
   It asks for your **DuckDNS subdomain** + **token**, then installs Caddy, wires up TLS,
   keeps DNS refreshed, updates the app's `APP_URL`, and restarts it.
4. Visit **https://mystream.duckdns.org** — it's live (first load takes up to a minute while
   LetsEncrypt issues the certificate).

---

## Step 5 — connect YouTube (optional, for uploads + YT live chat)

1. <https://console.cloud.google.com> → **Create project** → enable **YouTube Data API v3**.
2. **APIs & Services → Credentials → OAuth client ID → Web application**.
3. Add the redirect URI exactly:
   ```
   https://mystream.duckdns.org/auth/youtube/callback
   ```
4. Put the client ID/secret into `/opt/streampilot/.env` and restart:
   ```bash
   cd /opt/streampilot
   # edit .env:  YOUTUBE_CLIENT_ID=…  YOUTUBE_CLIENT_SECRET=…
   docker compose up -d
   ```
5. In the app → **Connections → YouTube → Connect with Google**.

> **Twitch / Kick chat** need no server-side changes — link them from the app's
> **Connections** tab (Twitch read works with zero keys; add a bot token to auto-reply).

---

## Day-to-day

| Task | Command (as root on the VM) |
|---|---|
| See logs | `docker compose -f /opt/streampilot/docker-compose.yml logs -f` |
| Restart | `docker compose -f /opt/streampilot/docker-compose.yml restart` |
| Update app | re-run `/opt/streampilot/scripts/setup-vps.sh` (it git-pulls + rebuilds) |
| Verify cloud | `cd /opt/streampilot && npm run cloudcheck` |

Everything is `restart: unless-stopped`, so it comes back after Oracle maintenance reboots.

---

## Troubleshooting

- **"Out of capacity" for the ARM shape** — retry at a quieter time, or switch to the
  `E2.1.Micro` free AMD shape.
- **`setup-vps.sh` can't reach GitHub** — check the VM's egress; Oracle images don't block
  outbound by default, but confirm the security list has an egress rule.
- **App shows "local mode" not "cloud"** — run `npm run cloudcheck`; the likely cause is a
  typo'd key or an egress block (rare on Oracle).
- **YouTube Connect redirect loops** — confirm the OAuth redirect URI in Google Cloud
  exactly matches `APP_URL + /auth/youtube/callback`.
- **Port 443 open but site times out** — Oracle Ubuntu has its own iptables rules;
  `setup-https.sh` already handles this, but double-check your VCN security list.

---

## Cost recap

| Item | Cost |
|---|---|
| Oracle Always-Free VM + 200 GB disk | $0 forever |
| DuckDNS subdomain + LetsEncrypt TLS | $0 |
| Appwrite (cloud db + storage) | $0 free tier |
| Streaming/capture sources | your existing accounts |
| **Total** | **$0** |
