/**
 * Cartercraft SFTP Proxy Server v1.6.1
 * Uses raw ssh2 only - no ssh2-sftp-client
 */

const express = require("express");
const cors    = require("cors");
const ssh2    = require("ssh2");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(req.method + " " + req.path + " body-keys=" + Object.keys(req.body || {}).join(","));
  next();
});

app.get("/",       (req, res) => res.json({ ok: true, service: "Cartercraft SFTP Proxy", version: "1.6.1" }));
app.get("/health", (req, res) => res.json({ ok: true, version: "1.6.1" }));

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

function closeConn(conn) { try { conn.end(); } catch (_) {} }

function rawRealPath(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.realPath(p, (err, res) => { if (err) return reject(err); resolve(res); });
  });
}

function rawList(sftp, p) {
  return new Promise((resolve, reject) => {
    // Use opendir + readdir loop to avoid the CLOSE error that Shockbyte
    // fires after completing a directory listing
    sftp.opendir(p, (err, handle) => {
      if (err) return reject(err);
      const all = [];
      const read = () => {
        sftp.readdir(handle, (err, list) => {
          if (err) {
            // CLOSE-related error after listing is done — return what we have
            sftp.close(handle, () => {});
            return resolve(all);
          }
          if (list === false) {
            // No more entries
            sftp.close(handle, () => {});
            return resolve(all);
          }
          all.push(...list);
          read();
        });
      };
      read();
    });
  });
}

async function guessHome(sftp) {
  try {
    const cwd = await rawRealPath(sftp, ".");
    if (cwd && cwd !== "/" && cwd.length > 1) {
      try { await rawList(sftp, cwd); return cwd; } catch (_) {}
    }
  } catch (_) {}
  try {
    const entries = await rawList(sftp, "/");
    for (const e of entries) {
      const isDir = e.longname ? e.longname.startsWith("d") : false;
      if (isDir) {
        const p = "/" + e.filename;
        try { await rawList(sftp, p); return p; } catch (_) {}
      }
    }
  } catch (_) {}
  for (const p of ["/opt/minecraft", "/minecraft", "/server", "/bedrock", "/data"]) {
    try { await rawList(sftp, p); return p; } catch (_) {}
  }
  try {
    const cwd = await rawRealPath(sftp, ".");
    if (cwd && cwd.length > 1) return cwd;
  } catch (_) {}
  return "/";
}

function rawReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const stream = sftp.createReadStream(remotePath);
    stream.on("data",  c => chunks.push(c));
    stream.on("end",   () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    stream.on("close", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    stream.on("error", err => {
      if (settled) return;
      settled = true;
      if (chunks.length > 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(err);
    });
  });
}

function rawWriteFile(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    stream.on("close", () => resolve());
    stream.on("error", err => reject(err));
    stream.end(Buffer.from(content, "utf8"));
  });
}

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
    console.error("connect error:", err.message);
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
    if (absPath === "/" || absPath === "" || absPath === ".") {
      absPath = await guessHome(sftp);
    }
    // If it's already an absolute path, use it directly — no realPath needed

    const entries = await rawList(sftp, absPath);
    closeConn(conn);

    const items = entries
      .filter(e => e.filename !== "." && e.filename !== "..")
      .map(e => ({
        name:  e.filename,
        path:  absPath.replace(/\/$/, "") + "/" + e.filename,
        isDir: e.longname ? e.longname.startsWith("d") : false,
        size:  e.attrs ? (e.attrs.size || 0) : 0,
        mtime: e.attrs ? (e.attrs.mtime || 0) : 0,
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ ok: true, path: absPath, items });
  } catch (err) {
    if (conn) closeConn(conn);
    console.error("list error:", err.message);
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
    const text = await rawReadFile(s.sftp, remotePath);
    closeConn(conn);
    res.json({ ok: true, path: remotePath, content: text });
  } catch (err) {
    if (conn) closeConn(conn);
    console.error("read-file error:", err.message);
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
    await rawWriteFile(s.sftp, remotePath, content);
    closeConn(conn);
    res.json({ ok: true, path: remotePath });
  } catch (err) {
    if (conn) closeConn(conn);
    console.error("write-file error:", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/resolve", async (req, res) => {
  const remotePath = req.body.path || ".";
  let conn;
  try {
    const s = await openSftp(req.body);
    conn = s.conn;
    const abs = await rawRealPath(s.sftp, remotePath);
    closeConn(conn);
    res.json({ ok: true, path: abs });
  } catch (err) {
    if (conn) closeConn(conn);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.use((req, res) => {
  console.log("404:", req.method, req.path);
  res.status(404).json({ ok: false, error: "Unknown route: " + req.method + " " + req.path });
});

app.listen(PORT, () => console.log("Cartercraft proxy v1.6.1 on port " + PORT));
