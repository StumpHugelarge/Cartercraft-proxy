/**
 * Cartercraft SFTP Proxy Server v1.4.0
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

app.get("/health", (req, res) => res.json({ ok: true, version: "1.4.0" }));

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
async function guessHome(client) {
  try {
    const cwd = await client.realPath(".");
    if (cwd && cwd !== "/" && cwd.length > 1) {
      try { await client.list(cwd); return cwd; } catch (_) {}
    }
  } catch (_) {}
  try {
    const rootEntries = await client.list("/");
    for (const entry of rootEntries) {
      if (entry.type === "d") {
        const p = "/" + entry.name;
        try { await client.list(p); return p; } catch (_) {}
      }
    }
  } catch (_) {}
  const candidates = ["/opt/minecraft", "/minecraft", "/server", "/bedrock", "/opt/bedrock", "/data"];
  for (const p of candidates) {
    try { await client.list(p); return p; } catch (_) {}
  }
  try {
    const cwd = await client.realPath(".");
    if (cwd && cwd.length > 1) return cwd;
  } catch (_) {}
  return "/";
}

// POST /connect
app.post("/connect", async (req, res) => {
  let client;
  try {
    client = await makeClient(req.body);
    const home = await guessHome(client);
    try { await client.end(); } catch (_) {}
    res.json({ ok: true, home });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /list
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
    try { await client.end(); } catch (_) {}
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

// POST /read-file
// Shockbyte throws a spurious "cannot perform CLOSE on servers list" error
// after streaming completes. We catch it and return data anyway if chunks arrived.
app.post("/read-file", async (req, res) => {
  const remotePath = req.body.path;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  let client;
  try {
    client = await makeClient(req.body);
    const chunks = [];
    let settled = false;

    const text = await new Promise(async (resolve, reject) => {
      let stream;
      try { stream = await client.get(remotePath); }
      catch (err) { return reject(err); }

      stream.on("data", chunk => chunks.push(chunk));

      stream.on("end", () => {
        if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); }
      });

      stream.on("close", () => {
        if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); }
      });

      stream.on("error", err => {
        if (settled) return;
        settled = true;
        // Shockbyte CLOSE error fires after data is done - treat as success if we have data
        if (chunks.length > 0) {
          resolve(Buffer.concat(chunks).toString("utf8"));
        } else {
          reject(err);
        }
      });
    });

    try { await client.end(); } catch (_) {}
    res.json({ ok: true, path: remotePath, content: text });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /write-file
app.post("/write-file", async (req, res) => {
  const { path: remotePath, content } = req.body;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  if (content === undefined) return res.status(400).json({ ok: false, error: "content is required" });
  let client;
  try {
    client = await makeClient(req.body);
    const buf = Buffer.from(content, "utf8");
    await client.put(buf, remotePath);
    try { await client.end(); } catch (_) {}
    res.json({ ok: true, path: remotePath });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /resolve
app.post("/resolve", async (req, res) => {
  const remotePath = req.body.path || ".";
  let client;
  try {
    client = await makeClient(req.body);
    const abs = await client.realPath(remotePath);
    try { await client.end(); } catch (_) {}
    res.json({ ok: true, path: abs });
  } catch (err) {
    if (client) { try { await client.end(); } catch (_) {} }
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Cartercraft SFTP proxy listening on port " + PORT);
});
