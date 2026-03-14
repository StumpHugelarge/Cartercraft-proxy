/**
 * Cartercraft SFTP Proxy Server v1.3.0
 * Bridges the PWA to Shockbyte SFTP
 * Deploy to Render (free tier)
 */

const express    = require("express");
const cors       = require("cors");
const SftpClient = require("ssh2-sftp-client");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, version: "1.3.0" }));

async function makeClient(body) {
  const { host, port, username, password } = body;
  if (!host || !username || !password) throw new Error("host, username, and password are required");
  const client = new SftpClient();
  await client.connect({
    host,
    port: parseInt(port) || 2222,
    username,
    password,
    readyTimeout: 15000,
    retries: 2,
    retry_factor: 2,
    retry_minTimeout: 2000,
  });
  return client;
}

// Shockbyte home guesser
// Bedrock servers use numbered root folders like "/1. Stumptown"
async function guessHome(client) {
  // 1. Try realPath(".") - SFTP working directory
  try {
    const cwd = await client.realPath(".");
    if (cwd && cwd !== "/" && cwd.length > 1) {
      try { await client.list(cwd); return cwd; } catch (_) {}
    }
  } catch (_) {}

  // 2. Scan root "/" for any listable folder
  // Shockbyte Bedrock uses numbered folders e.g. "/1. Stumptown"
  try {
    const rootEntries = await client.list("/");
    for (const entry of rootEntries) {
      if (entry.type === "d") {
        const p = "/" + entry.name;
        try { await client.list(p); return p; } catch (_) {}
      }
    }
  } catch (_) {}

  // 3. Common paths - intentionally skip /home which Shockbyte Bedrock doesn't use
  const candidates = ["/opt/minecraft", "/minecraft", "/server", "/bedrock", "/opt/bedrock", "/data"];
  for (const p of candidates) {
    try { await client.list(p); return p; } catch (_) {}
  }

  // 4. Last resort
  try {
    const cwd = await client.realPath(".");
    if (cwd && cwd.length > 1) return cwd;
  } catch (_) {}

  return "/";
}

// POST /connect - test credentials and return home directory
app.post("/connect", async (req, res) => {
  let client;
  try {
    client = await makeClient(req.body);
    const home = await guessHome(client);
    await client.end();
    res.json({ ok: true, home });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /list - list a remote directory
app.post("/list", async (req, res) => {
  const remotePath = req.body.path || ".";
  let client;
  try {
    client = await makeClient(req.body);
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
        name:  e.name,
        path:  absPath.replace(/\/$/, "") + "/" + e.name,
        isDir: e.type === "d",
        size:  e.size || 0,
        mtime: e.modifyTime || 0,
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ ok: true, path: absPath, items });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /read-file - read a remote file as UTF-8 text
app.post("/read-file", async (req, res) => {
  const remotePath = req.body.path;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  let client;
  try {
    client = await makeClient(req.body);
    const chunks = [];
    const stream = await client.get(remotePath);
    await new Promise((resolve, reject) => {
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    await client.end();
    const text = Buffer.concat(chunks).toString("utf8");
    res.json({ ok: true, path: remotePath, content: text });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /resolve - resolve a path to absolute
app.post("/resolve", async (req, res) => {
  const remotePath = req.body.path || ".";
  let client;
  try {
    client = await makeClient(req.body);
    const abs = await client.realPath(remotePath);
    await client.end();
    res.json({ ok: true, path: abs });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Cartercraft SFTP proxy listening on port " + PORT);
});
