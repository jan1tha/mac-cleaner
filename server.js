#!/usr/bin/env node
'use strict';

/*
 * mac-cleaner — a tiny local web app to scan and selectively clean
 * macOS temp / cache / junk locations, flag caches whose apps are running,
 * and inspect / purge MySQL schemas.
 *
 * - No external dependencies (Node built-ins only).
 * - Filesystem "cleaning" MOVES items to ~/.Trash (recoverable).
 * - MySQL purge is DROP DATABASE — permanent, and gated behind live credentials.
 * - Only paths enumerated by the category definitions can ever be cleaned.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const HOME = os.homedir();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
const j = (...p) => path.join(HOME, ...p);

// ---------- fs helpers ----------
function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function listChildren(dir) {
  try { return fs.readdirSync(dir).map(n => path.join(dir, n)); } catch { return []; }
}
function existing(paths) { return paths.filter(exists); }

// ---------- category definitions ----------
const CATEGORIES = [
  { id: 'updaters', title: 'App updater leftovers', risk: 'safe', run: true,
    desc: 'Downloaded auto-update packages (*.ShipIt). Pure junk.',
    collect: () => listChildren(j('Library/Caches')).filter(p => p.endsWith('.ShipIt')) },
  { id: 'user-caches', title: 'App caches  (~/Library/Caches)', risk: 'safe', run: true,
    desc: 'Per-app caches. Apps rebuild these on next launch.',
    collect: () => listChildren(j('Library/Caches')).filter(p => !p.endsWith('.ShipIt')) },
  { id: 'logs', title: 'App logs  (~/Library/Logs)', risk: 'safe', run: true,
    desc: 'Application log files.',
    collect: () => listChildren(j('Library/Logs')) },
  { id: 'workbench-logs', title: 'MySQL Workbench logs', risk: 'safe',
    desc: "Workbench's SQL-action history logs — client-side junk, not your DB data. It grows unbounded and Workbench recreates it.",
    collect: () => listChildren(j('Library/Application Support/MySQL/Workbench/log')) },
  { id: 'dev-caches', title: 'Developer build caches', risk: 'safe',
    desc: 'Maven / Gradle / npm / Go / Xcode caches. Re-downloaded or rebuilt on demand.',
    collect: () => existing([
      j('.m2/repository'), j('.gradle/caches'), j('.gradle/wrapper'),
      j('.npm/_cacache'), j('.cache'), j('go/pkg/mod'),
      j('Library/Developer/Xcode/DerivedData'), j('Library/Developer/CoreSimulator/Caches'),
    ]) },
  { id: 'ios-devsupport', title: 'Xcode iOS DeviceSupport', risk: 'review',
    desc: 'Debug symbols per iOS version. Safe unless actively on-device debugging.',
    collect: () => listChildren(j('Library/Developer/Xcode/iOS DeviceSupport')) },
  { id: 'user-temp', title: 'User temp  ($TMPDIR)', risk: 'review',
    desc: 'Per-user temp files. A running app may be using some — close apps first.',
    collect: () => listChildren(os.tmpdir()) },
  { id: 'downloads', title: 'Downloads  (review each!)', risk: 'review',
    desc: 'Your downloaded files. Nothing here is automatic — pick individually.',
    collect: () => listChildren(j('Downloads')) },
];

const INFO_ROOTS = [
  { title: 'Application Support', dir: j('Library/Application Support') },
  { title: 'Containers (sandboxed apps)', dir: j('Library/Containers') },
];

// ---------- running-app detection ----------
// Build a set of running bundle IDs + significant words from app / process names.
// No permission prompt: lsappinfo and ps are both unprivileged.
function runningApps() {
  const bundleIDs = new Set();
  const words = new Set();
  const addWords = s => {
    if (!s) return;
    for (const w of String(s).toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4) words.add(w);
  };
  try {
    const out = String(execFileSync('lsappinfo', ['list'], { maxBuffer: 8 << 20, timeout: 8000 }));
    for (const m of out.matchAll(/bundleID="([^"]+)"/g)) bundleIDs.add(m[1].toLowerCase());
    for (const m of out.matchAll(/^\s*\d+\)\s+"([^"]+)"/gm)) addWords(m[1]);
  } catch {}
  try {
    const ps = String(execFileSync('ps', ['-Axo', 'comm='], { maxBuffer: 8 << 20, timeout: 8000 }));
    for (const line of ps.split('\n')) if (line) addWords(line.split('/').pop());
  } catch {}
  return { bundleIDs, words };
}

// Returns the matched app hint if the item's owning app looks running, else null.
// Apple system folders are skipped (their daemons are always running and their
// caches are safe to clear anyway — flagging them is just noise).
function itemRunning(name, running) {
  const base = name.replace(/\.(ShipIt|savedState|Standalone)$/i, '').toLowerCase();
  if (base.startsWith('com.apple.') || base.startsWith('group.com.apple.')) return null;
  if (running.bundleIDs.has(base)) return base;
  const parts = base.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  for (const w of parts) if (running.words.has(w)) return w;
  return null;
}

// ---------- sizing ----------
function duSizes(paths, cb) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < paths.length; i += 120) chunks.push(paths.slice(i, i + 120));
  let idx = 0;
  const next = () => {
    if (idx >= chunks.length) return cb(map);
    execFile('du', ['-sk', ...chunks[idx]], { maxBuffer: 64 << 20 }, (_e, stdout) => {
      String(stdout || '').split('\n').forEach(line => {
        const t = line.indexOf('\t');
        if (t < 0) return;
        const kb = parseInt(line.slice(0, t), 10);
        if (!isNaN(kb)) map.set(line.slice(t + 1), kb);
      });
      idx++; next();
    });
  };
  next();
}

// ---------- scan ----------
function buildScan(cb) {
  const running = runningApps();
  const catItems = CATEGORIES.map(c => ({ cat: c, items: existing(c.collect()) }));
  const infoItems = INFO_ROOTS.map(r => ({ root: r, items: existing(listChildren(r.dir)) }));
  const allPaths = [...catItems.flatMap(c => c.items), ...infoItems.flatMap(r => r.items)];

  duSizes(allPaths, sizes => {
    const kb = p => sizes.get(p) || 0;

    const categories = catItems.map(({ cat, items }) => ({
      id: cat.id, title: cat.title, risk: cat.risk, desc: cat.desc,
      totalKb: items.reduce((s, p) => s + kb(p), 0),
      items: items.map(p => {
        const name = path.basename(p);
        const run = cat.run ? itemRunning(name, running) : null;
        return { path: p, name, kb: kb(p), running: !!run, runVia: run || '' };
      }).sort((a, b) => b.kb - a.kb),
    }));

    const info = infoItems.map(({ root, items }) => ({
      title: root.title, dir: root.dir,
      items: items.map(p => ({ name: path.basename(p), kb: kb(p) }))
        .sort((a, b) => b.kb - a.kb).slice(0, 12),
    }));

    cb({ generatedAt: new Date().toISOString(), home: HOME, categories, info });
  });
}

function allowedPaths() {
  const set = new Set();
  for (const c of CATEGORIES) for (const p of existing(c.collect())) set.add(p);
  return set;
}

function trashOne(p) {
  const trashDir = j('.Trash');
  try { fs.mkdirSync(trashDir, { recursive: true }); } catch {}
  let dest = path.join(trashDir, path.basename(p));
  if (exists(dest)) dest = path.join(trashDir, `${path.basename(p)} ${Date.now()}`);
  execFileSync('mv', [p, dest]);
  return dest;
}

// ---------- MySQL ----------
const MYSQL_SYSTEM = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
function mysqlBin() {
  const cands = ['/usr/local/mysql/bin/mysql', '/usr/local/mysql/bin/mysql',
    '/opt/homebrew/opt/mysql/bin/mysql', '/opt/homebrew/bin/mysql', '/usr/bin/mysql'];
  for (const c of cands) if (exists(c)) return c;
  try { return String(execFileSync('bash', ['-lc', 'command -v mysql'])).trim() || null; } catch { return null; }
}
function mysqlRun(creds, sql) {
  const bin = mysqlBin();
  if (!bin) throw new Error('mysql client not found on this Mac');
  const args = ['-N', '-B', '--connect-timeout=5',
    '-h', creds.host || '127.0.0.1', '-P', String(creds.port || 3306),
    '-u', creds.user || 'root'];
  if (creds.socket) args.push('--socket', creds.socket);
  args.push('-e', sql);
  const env = Object.assign({}, process.env, { MYSQL_PWD: creds.password || '' });
  try {
    return String(execFileSync(bin, args, { env, timeout: 20000, maxBuffer: 16 << 20 }));
  } catch (e) {
    // Surface MySQL's real message ("Access denied…", "Can't connect…") not the command line.
    const msg = (e.stderr && e.stderr.toString().trim()) || (e.message || String(e));
    throw new Error(msg.replace(/^mysql:\s*/i, ''));
  }
}
function mysqlSchemas(creds) {
  const sql =
    "SELECT s.schema_name, " +
    "COALESCE(SUM(t.data_length+t.index_length),0) AS bytes, " +
    "COUNT(t.table_name) AS tbls " +
    "FROM information_schema.schemata s " +
    "LEFT JOIN information_schema.tables t ON t.table_schema=s.schema_name " +
    "GROUP BY s.schema_name ORDER BY bytes DESC;";
  const rows = mysqlRun(creds, sql).split('\n').filter(Boolean).map(line => {
    const [name, bytes, tbls] = line.split('\t');
    return { name, bytes: parseInt(bytes, 10) || 0, tables: parseInt(tbls, 10) || 0,
             system: MYSQL_SYSTEM.has(name) };
  });
  return rows;
}
function mysqlDrop(creds, databases) {
  const existingNames = new Set(mysqlSchemas(creds).map(s => s.name));
  const results = [];
  for (const db of databases) {
    if (typeof db !== 'string' || MYSQL_SYSTEM.has(db) || !existingNames.has(db)) {
      results.push({ db, ok: false, error: 'system or unknown schema — refused' });
      continue;
    }
    try {
      mysqlRun(creds, 'DROP DATABASE `' + db.replace(/`/g, '``') + '`;');
      results.push({ db, ok: true });
    } catch (e) {
      results.push({ db, ok: false, error: String(e && e.message || e).split('\n')[0] });
    }
  }
  return results;
}

// ---------- http ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb(null); } });
}

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const FAVICON = fs.readFileSync(path.join(__dirname, 'public', 'favicon.svg'));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX);
  }

  if (req.method === 'GET' && (url === '/favicon.svg' || url === '/favicon.ico')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    return res.end(FAVICON);
  }

  if (req.method === 'GET' && url === '/api/scan') {
    try { buildScan(d => sendJSON(res, 200, d)); }
    catch (e) { sendJSON(res, 500, { error: String(e && e.message || e) }); }
    return;
  }

  if (req.method === 'POST' && url === '/api/clean') {
    return readBody(req, data => {
      if (!data || !Array.isArray(data.paths)) return sendJSON(res, 400, { error: 'paths must be an array' });
      const allowed = allowedPaths();
      const results = [];
      let freedKb = 0;
      for (const p of data.paths) {
        if (typeof p !== 'string' || !allowed.has(p)) { results.push({ path: p, ok: false, error: 'not in allow-list' }); continue; }
        try {
          let kb = 0;
          try { kb = parseInt(String(execFileSync('du', ['-sk', p])).split('\t')[0], 10) || 0; } catch {}
          const dest = trashOne(p);
          freedKb += kb;
          results.push({ path: p, ok: true, kb, trashedTo: dest });
        } catch (e) { results.push({ path: p, ok: false, error: String(e && e.message || e) }); }
      }
      sendJSON(res, 200, { freedKb, results });
    });
  }

  if (req.method === 'POST' && url === '/api/mysql/schemas') {
    return readBody(req, data => {
      if (!data) return sendJSON(res, 400, { error: 'bad json' });
      try { sendJSON(res, 200, { ok: true, schemas: mysqlSchemas(data) }); }
      catch (e) { sendJSON(res, 200, { ok: false, error: String(e && e.message || e).split('\n')[0] }); }
    });
  }

  if (req.method === 'POST' && url === '/api/mysql/drop') {
    return readBody(req, data => {
      if (!data || !Array.isArray(data.databases) || data.confirm !== true)
        return sendJSON(res, 400, { error: 'databases[] and confirm:true required' });
      try { sendJSON(res, 200, { ok: true, results: mysqlDrop(data, data.databases) }); }
      catch (e) { sendJSON(res, 200, { ok: false, error: String(e && e.message || e).split('\n')[0] }); }
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  🧹  mac-cleaner running at  ${link}`);
  console.log(`      Filesystem cleaning → ~/.Trash (recoverable). MySQL purge → permanent.\n`);
  try { execFile('open', [link]); } catch {}
});
