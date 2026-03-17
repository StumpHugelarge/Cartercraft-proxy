/**
 * Cartercraft SFTP Proxy Server v1.5.0
 * Bridges the PWA to Shockbyte SFTP
 * Deploy to Render (free tier)
 */

const express    = require("express");
const cors       = require("cors");
const SftpClient = require("ssh2-sftp-client");
const ssh2       = require("ssh2");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, version: "1.5.0" }));

// ── Standard sftp-client for list/connect ──────────────────────────────────

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

// ── Raw ssh2 file reader — bypasses ssh2-sftp-client's CLOSE handling ──────
// ssh2-sftp-client throws on the CLOSE packet that Shockbyte sends after EOF.
// Using ssh2 directly lets us ignore that and just return the buffered data.

function readFileRaw(body, remotePath) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password } = body;
    const conn = new ssh2.Client();
    const chunks = [];

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }

        const stream = sftp.createReadStream(remotePath);

        stream.on("data", chunk => chunks.push(chunk));

        stream.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          // Give the stream a tick to fully close before ending conn
          setImmediate(() => { try { conn.end(); } catch(_) {} });
          resolve(text);
        });

        stream.on("error", err => {
          // Shockbyte sends CLOSE after EOF which ssh2 surfaces as an error.
          // If we got data, return it; otherwise reject.
          const text = Buffer.concat(chunks).toString("utf8");
          try { conn.end(); } catch(_) {}
          if (chunks.length > 0) {
            resolve(text);
          } else {
            reject(err);
          }
        });

        stream.on("close", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try { conn.end(); } catch(_) {}
          resolve(text);
        });
      });
    });

    conn.on("error", err => reject(err));

    conn.connect({
      host,
      port: parseInt(port) || 2222,
      username,
      password,
      readyTimeout: 15000,
    });
  });
}

// ── Same approach for write ────────────────────────────────────────────────

function writeFileRaw(body, remotePath, content) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password } = body;
    const conn = new ssh2.Client();
    const buf = Buffer.from(content, "utf8");

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }

        const stream = sftp.createWriteStream(remotePath);

        stream.on("close", () => {
          try { conn.end(); } catch(_) {}
          resolve();
        });

        stream.on("error", err => {
          try { conn.end(); } catch(_) {}
          reject(err);
        });

        stream.end(buf);
      });
    });

    conn.on("error", err => reject(err));

    conn.connect({
      host,
      port: parseInt(port) || 2222,
      username,
      password,
      readyTimeout: 15000,
    });
  });
}

// ── Shockbyte home guesser ─────────────────────────────────────────────────

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

// ── Routes ─────────────────────────────────────────────────────────────────

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

app.post("/read-file", async (req, res) => {
  const remotePath = req.body.path;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  try {
    const text = await readFileRaw(req.body, remotePath);
    res.json({ ok: true, path: remotePath, content: text });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/write-file", async (req, res) => {
  const { path: remotePath, content } = req.body;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  if (content === undefined) return res.status(400).json({ ok: false, error: "content is required" });
  try {
    await writeFileRaw(req.body, remotePath, content);
    res.json({ ok: true, path: remotePath });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

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
