/**
 * Cartercraft SFTP Proxy Server v1.6.0
 * All SFTP operations use raw ssh2 directly.
 * ssh2-sftp-client is NOT used - it mishandles the CLOSE packet
 * that Shockbyte sends after every operation.
 */

const express = require("express");
const cors    = require("cors");
const ssh2    = require("ssh2");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, version: "1.6.0" }));

// ── Core: open a raw ssh2 SFTP session ────────────────────────────────────

function openSftp(body) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password } = body;
    if (!host || !username || !password) {
      return reject(new Error("host, username, and password are required"));
    }
    const conn = new ssh2.Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        resolve({ conn, sftp });
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

function closeConn(conn) {
  try { conn.end(); } catch (_) {}
}

// ── realPath ──────────────────────────────────────────────────────────────

function realPath(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.realPath(p, (err, resolved) => {
      if (err) return reject(err);
      resolve(resolved);
    });
  });
}

// ── list directory ────────────────────────────────────────────────────────

function sftpList(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.readdir(p, (err, list) => {
      if (err) return reject(err);
      resolve(list);
    });
  });
}

// ── guess Shockbyte home ──────────────────────────────────────────────────

async function guessHome(sftp) {
  // 1. realPath(".")
  try {
    const cwd = await realPath(sftp, ".");
    if (cwd && cwd !== "/" && cwd.length > 1) {
      try { await sftpList(sftp, cwd); return cwd; } catch (_) {}
    }
  } catch (_) {}

  // 2. Scan root for Shockbyte-style numbered folders e.g. "/1. Stumptown"
  try {
    const entries = await sftpList(sftp, "/");
    for (const e of entries) {
      if (e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()) {
        const p = "/" + e.filename;
        try { await sftpList(sftp, p); return p; } catch (_) {}
      }
      // ssh2 uses longname/attrs differently depending on version
      if (e.longname && e.longname.startsWith("d")) {
        const p = "/" + e.filename;
        try { await sftpList(sftp, p); return p; } catch (_) {}
      }
    }
  } catch (_) {}

  // 3. Common paths
  for (const p of ["/opt/minecraft", "/minecraft", "/server", "/bedrock", "/data"]) {
    try { await sftpList(sftp, p); return p; } catch (_) {}
  }

  return "/";
}

// ── read file ─────────────────────────────────────────────────────────────

function sftpReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const stream = sftp.createReadStream(remotePath);

    stream.on("data",  chunk => chunks.push(chunk));

    stream.on("end", () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); }
    });

    stream.on("close", () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); }
    });

    stream.on("error", err => {
      if (settled) return;
      settled = true;
      // Shockbyte fires a CLOSE-related error after EOF — if we have data, succeed
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(err);
      }
    });
  });
}

// ── write file ────────────────────────────────────────────────────────────

function sftpWriteFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const buf    = Buffer.from(content, "utf8");
    const stream = sftp.createWriteStream(remotePath);
    stream.on("close", () => resolve());
    stream.on("error", err => reject(err));
    stream.end(buf);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────

app.post("/connect", async (req, res) => {
  let conn;
  try {
    const s = await openSftp(req.body);
    conn = s.conn;
    const home = await guessHome(s.sftp);
    closeConn(conn);
    res.json({ ok: true, home });
  } catch (err) {
    if (conn) closeConn(conn);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/list", async (req, res) => {
  const remotePath = req.body.path || ".";
  let conn;
  try {
    const s = await openSftp(req.body);
    conn = s.conn;
    const { sftp } = s;

    let absPath = remotePath;
    if (absPath === "/" || absPath === "") {
      absPath = await guessHome(sftp);
    } else {
      try {
        const resolved = await realPath(sftp, remotePath);
        absPath = (resolved && resolved !== "/") ? resolved : await guessHome(sftp);
      } catch (_) {
        absPath = await guessHome(sftp);
      }
    }

    const entries = await sftpList(sftp, absPath);
    closeConn(conn);

    const items = entries
      .map(e => {
        const isDir = e.longname ? e.longname.startsWith("d") : !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory());
        return {
          name:  e.filename,
          path:  absPath.replace(/\/$/, "") + "/" + e.filename,
          isDir,
          size:  e.attrs ? e.attrs.size || 0 : 0,
          mtime: e.attrs ? e.attrs.mtime || 0 : 0,
        };
      })
      .filter(e => e.name !== "." && e.name !== "..")
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ ok: true, path: absPath, items });
  } catch (err) {
    if (conn) closeConn(conn);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/read-file", async (req, res) => {
  const remotePath = req.body.path;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  let conn;
  try {
    const s = await openSftp(req.body);
    conn = s.conn;
    const text = await sftpReadFile(s.sftp, remotePath);
    closeConn(conn);
    res.json({ ok: true, path: remotePath, content: text });
  } catch (err) {
    if (conn) closeConn(conn);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/write-file", async (req, res) => {
  const { path: remotePath, content } = req.body;
  if (!remotePath) return res.status(400).json({ ok: false, error: "path is required" });
  if (content === undefined) return res.status(400).json({ ok: false, error: "content is required" });
  let conn;
  try {
    const s = await openSftp(req.body);
    conn = s.conn;
    await sftpWriteFile(s.sftp, remotePath, content);
    closeConn(conn);
    res.json({ ok: true, path: remotePath });
  } catch (err) {
    if (conn) closeConn(conn);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/resolve", async (req, res) => {
  const remotePath = req.body.path || ".";
  let conn;
  try {
    const s = await openSftp(req.body);
    conn = s.conn;
    const abs = await realPath(s.sftp, remotePath);
    closeConn(conn);
    res.json({ ok: true, path: abs });
  } catch (err) {
    if (conn) closeConn(conn);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log("Cartercraft SFTP proxy listening on port " + PORT);
});
