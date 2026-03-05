# Cartercraft SFTP Proxy — Deploy Guide

## What this is
A tiny Node.js server that sits between your iPhone PWA and your Shockbyte SFTP server.
Your iPhone can't talk SFTP directly (browser security) — this proxy handles it.

---

## Deploy to Railway (Free, ~2 min)

1. Go to **railway.app** and sign up (free, GitHub login works great)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Upload the `cartercraft-proxy` folder as a new GitHub repo:
   - Go to github.com → New repository → name it `cartercraft-proxy`
   - Upload `server.js` and `package.json`
4. Back in Railway, select your new repo
5. Railway auto-detects Node.js and deploys it
6. Click your deployment → **Settings** → copy the **Public URL**
   (looks like `https://cartercraft-proxy-production.up.railway.app`)

---

## Configure the PWA

In the Cartercraft app on your iPhone:
1. Go to **Settings → SFTP Credentials**
2. Paste your Railway URL into **"Proxy URL"**
3. Fill in your Shockbyte SFTP details:
   - **Host**: your Shockbyte SFTP hostname (e.g. `s1.shockbyte.com`)
   - **Port**: `2222` (Shockbyte default)
   - **Username / Password**: your Shockbyte credentials
4. Tap **⚡ Test Connection** — you should see "✓ Connected!"
5. Tap **Save Settings**

Now when you tap the World Folder or Packs Root in Settings, 
you'll get a live folder browser of your Shockbyte server!

---

## Alternative: Render.com (also free)

1. Go to **render.com** → New → Web Service
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Copy the URL from your dashboard

---

## Security note
Your SFTP credentials are sent from your iPhone to the proxy over HTTPS (encrypted).
The proxy never stores them — each request connects fresh and disconnects immediately.
For extra security, you can add an API key check to server.js if needed.
