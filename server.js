/**
 * Cartercraft SFTP Proxy Server
 * Bridges the PWA to Shockbyte SFTP
 * Deploy to Railway / Render (free tier)
 */

const express    = require("express");
const cors       = require("cors");
const SftpClient = require("ssh2-sftp-client");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, version: "1.0.0" }));

// ── Helper: build + connect a client from request body ───
async function makeClient(body) {
  const { host, port, username, password } = body;
  if (!host || !username || !password) {
    throw new Error("host, username, and password are required");
  }
  const client = new SftpClient();
  await client.connect({
    host,
    port:     parseInt(port) || 2222,
    username,
    password,
    readyTimeout: 15000,
    // Shockbyte uses non-standard CLOSE errors — keep retrying
    retries:  2,
    retry_factor:  2,
    retry_minTimeout: 2000,
  });
  return client;
}

// ── POST /connect  ── test credentials ───────────────────
app.post("/connect", async (req, res) => {
  let client;
  try {
    client = await makeClient(req.body);
    // Resolve home directory
    let home = ".";
    try {
      home = await client.realPath(".");
      if (!home || home === "/") home = await guessHome(client);
    } catch (_) {
      home = await guessHome(client);
    }
    await client.end();
    res.json({ ok: true, home });
  } catch (err) {
    if (client) { try { await client.end(); } catch(_){} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── POST /list  ── list a remote directory ────────────────
app.post("/list", async (req, res) => {
  const { path: remotePath = "." } = req.body;
  let client;
  try {
    client = await makeClient(req.body);

    // Resolve path safely (never list "/")
    let absPath = remotePath;
    if (absPath === "/" || absPath === "") {
      absPath = await guessHome(client);
    } else {
      try {
        const resolved = await client.realPath(remotePath);
        absPath = (resolved && resolved !== "/") ? resolved : await guessHome(client);
      } catch (_) {
        absPath = await guessHome(client);
      }
    }

    const entries = await client.list(absPath);
    await client.end();

    const items = entries
      .map(e => ({
        name:   e.name,
        path:   absPath.replace(/\/$/, "") + "/" + e.name,
        isDir:  e.type === "d",
        size:   e.size || 0,
        mtime:  e.modifyTime || 0,
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ ok: true, path: absPath, items });
  } catch (err) {
    if (client) { try { await client.end(); } catch(_){} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── POST /resolve  ── resolve a path to absolute ─────────
app.post("/resolve", async (req, res) => {
  const { path: remotePath = "." } = req.body;
  let client;
  try {
    client = await makeClient(req.body);
    const abs = await client.realPath(remotePath);
    await client.end();
    res.json({ ok: true, path: abs });
  } catch (err) {
    if (client) { try { await client.end(); } catch(_){} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Shockbyte home directory guesser ─────────────────────
async function guessHome(client) {
  const candidates = ["/data", "/home/container", "/minecraft",
                      "/opt/minecraft", "/server"];
  for (const p of candidates) {
    try {
      await client.list(p);
      return p;
    } catch (_) {}
  }
  return "/data";
}

app.listen(PORT, () => {
  console.log(`Cartercraft SFTP proxy listening on port ${PORT}`);
});
