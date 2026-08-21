# Going Live With SAFE_Links — Complete Step-by-Step Guide

Written assuming you've never deployed a website or built an app
before. Every step tells you exactly what to type or click, and what
you should see if it worked.

---

## Part 0: Get the code

```bash
git clone <your repo's URL here> safe-links
cd safe-links
```

(If you're reading this file already inside a cloned copy, you've done
this already — skip ahead.)

Everything in this guide refers to paths relative to this repo's root
— `web-app/`, `android-app/`, `desktop-app/`, `tools/`.

The `tools/lan-pairing-test/` folder is optional, not required to go
live — a small standalone script for testing one specific feature
(LAN router pairing) later. Ignore it for now.

---

## The big picture — 4 phases

You're building **3 things** that all point at **1 website**:

```
┌─────────────────────────────────────────────┐
│  Phase 1: Put the website on the internet    │  <- do this FIRST,
│  (this is the actual product — everything    │     everything else
│   else is just a "window" into it)           │     needs this done
└─────────────────────────────────────────────┘     first
                      │
      ┌───────────────┼───────────────┐
      v                v               v
┌───────────┐   ┌─────────────┐  ┌──────────────┐
│ Phase 2:  │   │ Phase 3:    │  │ (Phase 2 & 3 │
│ Android   │   │ Windows     │  │  can happen  │
│ app       │   │ desktop app │  │  in any order,│
│           │   │             │  │  or skip one) │
└───────────┘   └─────────────┘  └──────────────┘
                      │
                      v
              ┌───────────────┐
              │ Phase 4:      │
              │ Go-live       │
              │ checklist     │
              └───────────────┘
```

**You cannot skip Phase 1.** The Android and Windows apps are empty
windows — they don't work at all until they have a real website
address to point at.

---

## Phase 1: Put the website online

### Step 1.1 — Get two things you don't have yet

You need to **buy** these two things (real money, but cheap — a few
dollars):

1. **A domain name** — like `mysafelinks.com`. Buy one from any
   registrar: Namecheap, GoDaddy, Google Domains, etc. Costs roughly
   $10–15/year.
2. **A server (a "VPS")** — a computer that's always on, rented by the
   month. Recommended, cheapest reliable options:
   - [DigitalOcean](https://www.digitalocean.com) — a "Droplet",
     $6/month tier is enough to start.
   - [Hetzner](https://www.hetzner.com) — usually even cheaper.
   - Any provider works as long as you pick **Ubuntu 22.04 or 24.04**
     as the operating system when creating it.

**What you'll end up with:** an IP address (four numbers like
`164.90.123.45`) for your server, and a domain name you own.

✅ **Checkpoint:** You have a domain name and a server IP address
written down somewhere.

### Step 1.2 — Point your domain at your server

On your domain registrar's website, find **DNS settings** (sometimes
called "DNS management" or "Manage DNS"). Add one record:

| Type | Name/Host | Value |
|---|---|---|
| A | `@` (or leave blank — means "the root domain") | your server's IP address |

Save it. This can take anywhere from 2 minutes to a few hours to
"propagate" (spread across the internet). You can check if it's ready
by typing your domain into [whatsmydns.net](https://www.whatsmydns.net)
— once most locations show your server's IP, it's ready.

✅ **Checkpoint:** `whatsmydns.net` shows your server's IP address for
your domain in most locations.

### Step 1.3 — Connect to your server

You'll need a terminal program:
- **Windows:** Use **PowerShell** (search for it in the Start Menu) —
  it has SSH built in on modern Windows.
- **Mac:** Use **Terminal** (search Spotlight for it).

Connect (replace with your real IP — your VPS provider emails you the
login details when you create the server):

```bash
ssh root@YOUR_SERVER_IP
```

Type `yes` if it asks about a fingerprint the first time. Enter the
password your VPS provider gave you.

✅ **Checkpoint:** Your terminal prompt changes to something like
`root@ubuntu-server:~#` — you're now typing commands *on the server*,
not your own computer.

### Step 1.4 — Install Docker on the server

Copy-paste this whole block into the terminal you just connected, and
press Enter:

```bash
curl -fsSL https://get.docker.com | sh
```

Wait for it to finish (a minute or two).

✅ **Checkpoint:** Run `docker --version` — it should print something
like `Docker version 27.x.x`.

### Step 1.5 — Get the `web-app` folder onto the server

Back on **your own computer** (not the server — open a *second*
terminal window/tab, don't disconnect from the server), from inside
your cloned `safe-links` folder, find the `web-app`
folder. Upload just that folder to your server:

```bash
scp -r web-app root@YOUR_SERVER_IP:/root/safe-links
```

This copies the whole folder over. Takes a minute or two depending on
your internet speed.

✅ **Checkpoint:** Back in your **server** terminal window, type
`ls /root/safe-links` — you should see `docker-compose.yml`,
`Caddyfile`, `frontend`, `reslink-backend`, `README.md`.

### Step 1.6 — Set your domain in the Caddyfile (on the server)

Still in your server terminal:

```bash
cd /root/safe-links
nano Caddyfile
```

This opens a simple text editor. You'll see:
```
yourdomain.com {
  reverse_proxy frontend:80
}
```
Change `yourdomain.com` to your **real domain** (the one you bought in
Step 1.1). Then press `Ctrl+O`, Enter (saves), then `Ctrl+X` (exits).

### Step 1.7 — Set two secret passwords

```bash
cp .env.example .env
openssl rand -hex 32
```

That second command prints a long random string — copy it. Then:

```bash
nano .env
```

You'll see empty fields. Fill in:
- `JWT_SECRET=` -> paste the long random string you just copied
- `POSTGRES_PASSWORD=` -> make up any strong password (e.g.
  `Xk9#mQ2vL8pR`)

Leave the `SMTP_*` lines blank for now — the system works fine without
them (see the README for what that means). Save (`Ctrl+O`, Enter,
`Ctrl+X`).

### Step 1.8 — Launch it

```bash
docker compose up -d --build
```

This takes several minutes the first time — it's building the whole
app from scratch. You'll see a lot of text scroll by. That's normal.

✅ **Checkpoint:** When it stops and gives you back a prompt, run:
```bash
docker compose ps
```
You should see 4 services (`postgres`, `backend`, `frontend`, `caddy`)
all saying `running` or `healthy`.

### Step 1.9 — Visit your website

Open a browser on your own computer and go to `https://yourdomain.com`
(your real domain). Give it a minute if it doesn't load instantly —
Caddy is fetching a security certificate automatically the first time.

✅ **Checkpoint:** You see the SAFE_Links welcome/login screen, over a
padlocked `https://` connection.

**Phase 1 done. This is the biggest milestone — everything else
depends on this working.**

---

## Phase 2: Build the Android app

You need a Windows, Mac, or Linux computer (not the server) with
**Android Studio** installed — download it free from
[developer.android.com/studio](https://developer.android.com/studio)
if you don't have it. Installing it is just "Next, Next, Finish" —
accept the defaults.

### Step 2.1 — Point the app at your real website

In your cloned repo, open `android-app/capacitor.config.json` in any plain text editor (Notepad
is fine). Find this line:

```json
"url": "https://REPLACE-WITH-YOUR-DOMAIN.com/",
```

Change it to your real domain from Phase 1, e.g.:

```json
"url": "https://yourdomain.com/",
```

Save the file.

### Step 2.2 — Open it in Android Studio

1. Open Android Studio.
2. Click **Open**.
3. Navigate to `safe-links/android-app/android` (the
   `android` folder *inside* `android-app` — not `android-app` itself).
4. Click **Open**.

Android Studio will now "sync" — a progress bar at the bottom, taking
a few minutes the first time as it downloads things it needs. **Just
wait.** Don't click anything else while it's syncing.

✅ **Checkpoint:** The progress bar disappears and you see the file
list on the left with no red error icons.

### Step 2.3 — Try it on your phone (recommended before building for real)

1. On your Android phone: **Settings -> About phone**, tap **Build
   number** 7 times (unlocks Developer Options).
2. **Settings -> Developer options** -> turn on **USB debugging**.
3. Plug your phone into your computer with a USB cable.
4. In Android Studio, look at the top toolbar — there's a dropdown
   (probably says "app") and a green **Run ▶** button next to it. Your
   phone's name should appear in a device dropdown. Click **Run ▶**.

✅ **Checkpoint:** The app installs and opens on your actual phone,
showing the picker screen: "I'm a Reseller / Admin" or "I'm pairing a
router".

### Step 2.4 — Build the real file to distribute (the APK)

Once you're happy it works:

1. In Android Studio's top menu: **Build -> Build Bundle(s) / APK(s) ->
   Build APK(s)**.
2. Wait for it to finish — a notification pops up bottom-right saying
   "APK(s) generated successfully".
3. Click **locate** in that notification to find the file — it's
   named something like `app-debug.apk`.

This debug version works for testing and even real internal use, but
Android will show a small warning that it's a "debug build" when
installing. For a polished version without that warning (needed before
publishing to the Play Store), see `android-app/README.md`'s section
on **signing** — that step needs a "keystore" (a security file only
you should hold), which isn't something anyone can generate for you.

**Phase 2 done.**

---

## Phase 3: Build the Windows desktop app

You need a **Windows PC** for the final step of this phase (the
installer-building tool only runs on Windows). The first part can be
done on Mac/Linux/Windows though.

### Step 3.1 — Install Node.js

Download and install from [nodejs.org](https://nodejs.org) — pick the
LTS version. Just click through the installer with defaults.

### Step 3.2 — Point the app at your real website

Open `desktop-app/src/main.js` in Notepad
or any text editor. Near the top, find:

```js
const SERVER_URL = "https://REPLACE-WITH-YOUR-DOMAIN.com/";
```

Change it to your real domain:

```js
const SERVER_URL = "https://yourdomain.com/";
```

Save.

### Step 3.3 — Build the app

Open a terminal (PowerShell on Windows) and navigate into the
`desktop-app` folder:

```bash
cd path\to\safe-links\desktop-app
npm install
npm run package:win
```

`npm install` takes under a minute. `npm run package:win` takes a
minute or two and produces a lot of output — that's normal.

✅ **Checkpoint:** A new folder appears:
`desktop-app\dist\SAFE_Links-win32-x64\`. Inside it is
`SAFE_Links.exe` — double-click it right now to confirm it opens and
shows the picker screen, same as the Android app did.

### Step 3.4 — Build the installer (Windows only, from here on)

1. Install **Inno Setup** — free, from
   [jrsoftware.org/isdl.php](https://jrsoftware.org/isdl.php). Click
   through the installer with defaults.
2. Open **Inno Setup Compiler** (it installs a Start Menu shortcut).
3. **File -> Open** -> select `desktop-app/SAFE_Links.iss`.
4. Press **F9** (or **Build -> Compile**).

✅ **Checkpoint:** A new folder `desktop-app\Output\` appears,
containing `SAFE_Links-Setup.exe` — that single file is what you hand
out to people. Running it installs the app with a Start Menu entry,
just like any other Windows program.

**Note:** Windows will likely show a blue "Windows protected your PC"
warning the first time anyone runs this installer, since it isn't
digitally signed. This is expected for any unsigned app — there's a
small "More info -> Run anyway" link to get past it. Removing this
warning permanently requires buying a code-signing certificate, a
separate, optional step covered in `desktop-app/README.md`.

**Phase 3 done.**

---

## Phase 4: Before you let real customers in

Go back to your server terminal (`ssh root@YOUR_SERVER_IP`) and your
browser at `https://yourdomain.com`, and do these in order:

- [ ] **Log in as Super Admin** (`admin@reslink.io` / `admin123` — the
      built-in demo login) and go to **Settings**. Set your *real*
      contact email/WhatsApp and *real* bank details — this is where
      resellers will pay their license fee.
- [ ] **Change or remove the demo accounts.** They're for evaluation
      only. On the server:
      ```bash
      cd /root/safe-links
      nano reslink-backend/src/db.js
      ```
      Find the `seed()` function and either change the demo passwords
      or delete the demo account creation entirely, then rebuild:
      ```bash
      docker compose up -d --build
      ```
- [ ] **(Optional) Set up real email.** Without this, license-expiry
      warnings go to a Super Admin notification instead of an email —
      the system still works fully either way. If you want real email,
      edit `.env` on the server (`nano .env`) with your SMTP provider's
      details, then `docker compose up -d --build` again.
- [ ] **Read the Limitations section** in
      `web-app/reslink-backend/README.md` — most importantly, the
      MikroTik/Linux router-pairing scripts are real code but haven't
      been run against physical hardware yet. Test against one spare
      router before handing this to a paying reseller.

---

## If something doesn't work

- **Website won't load (Phase 1.9):** run `docker compose logs` on the
  server and look for red "error" lines — usually either the domain
  DNS hasn't finished propagating yet (wait longer, recheck
  whatsmydns.net), or a typo in `Caddyfile`/`.env`.
- **Android Studio shows red errors after opening:** almost always
  means it's still syncing/downloading — wait for the progress bar at
  the bottom to fully finish before worrying about red text.
- **`npm install` fails on the desktop app:** almost always means
  Node.js isn't actually installed yet, or you're in the wrong folder
  — check you're inside `desktop-app` (`cd` there first).
- **Inno Setup won't open `.iss` file / shows an error compiling:**
  Inno Setup itself must be installed first (Step 3.4.1) — this is
  separate software from Node.js.

If you get stuck on something not listed here, copy the exact error
message you're seeing and ask — a specific error is much easier to
help with than "it didn't work".
