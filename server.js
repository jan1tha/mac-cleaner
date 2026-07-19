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

// DEMO=1 serves synthetic data (for screenshots/docs) — no real disk is scanned.
const DEMO = process.env.DEMO === '1';
const DEMO_DATA = {
  generatedAt: '2025-01-01T00:00:00.000Z', home: '/Users/alex', mysqlAvailable: true, spotlight: true,
  categories: [
    { id: 'dev-caches', title: 'Developer build caches', risk: 'safe',
      desc: 'Package-manager and build caches (npm, Yarn, Gradle, Cargo, Go). Re-downloaded on demand.', totalKb: 7_000_000,
      items: [
        { name: 'Gradle caches', kb: 3_800_000, path: '/Users/alex/.gradle/caches', running: false, runVia: '' },
        { name: 'Go modules', kb: 2_100_000, path: '/Users/alex/go/pkg/mod', running: false, runVia: '' },
        { name: 'npm cache', kb: 1_100_000, path: '/Users/alex/.npm/_cacache', running: false, runVia: '' },
      ] },
    { id: 'user-caches', title: 'App caches  (~/Library/Caches)', risk: 'safe',
      desc: 'Per-app caches. Apps rebuild these on next launch.', totalKb: 2_240_000,
      items: [
        { name: 'Chrome', kb: 1_310_000, path: '/Users/alex/Library/Caches/Google', running: true, runVia: 'chrome' },
        { name: 'Slack', kb: 620_000, path: '/Users/alex/Library/Caches/com.tinyspeck.slackmacgap', running: true, runVia: 'slack' },
        { name: 'Spotify', kb: 180_000, path: '/Users/alex/Library/Caches/com.spotify.client', running: false, runVia: '' },
        { name: 'Figma', kb: 130_000, path: '/Users/alex/Library/Caches/com.figma.Desktop', running: false, runVia: '' },
      ] },
    { id: 'logs', title: 'App logs  (~/Library/Logs)', risk: 'safe',
      desc: 'Application log files.', totalKb: 342_000,
      items: [{ name: 'JetBrains', kb: 210_000, path: '/Users/alex/Library/Logs/JetBrains', running: false, runVia: '' },
        { name: 'zoom.us', kb: 132_000, path: '/Users/alex/Library/Logs/zoom.us', running: false, runVia: '' }] },
    { id: 'app-support', title: 'Application Support  (real app data!)', risk: 'review',
      desc: 'Each app keeps its settings, databases and saved files here. Deleting a folder resets or WIPES that app — not junk, so review carefully.', totalKb: 24_600_000,
      items: [
        { name: 'Docker', kb: 9_100_000, path: '/Users/alex/Library/Application Support/Docker', running: false, runVia: '' },
        { name: 'VirtualBox VMs', kb: 8_200_000, path: '/Users/alex/Library/Application Support/VirtualBox', running: true, runVia: 'virtualbox' },
        { name: 'Postgres', kb: 5_100_000, path: '/Users/alex/Library/Application Support/Postgres', running: false, runVia: '' },
        { name: 'Code', kb: 2_200_000, path: '/Users/alex/Library/Application Support/Code', running: true, runVia: 'code' },
      ] },
    { id: 'maven', title: 'Maven repository  (~/.m2)', risk: 'review',
      desc: 'Cached Java/Maven dependencies. Frees a lot, but every project re-downloads on the next build (slow, needs network). Remove only if you no longer build those projects.', totalKb: 12_100_000,
      items: [{ name: '.m2/repository', kb: 12_100_000, path: '/Users/alex/.m2/repository', running: false, runVia: '' }] },
    { id: 'downloads', title: 'Downloads  (review each!)', risk: 'review',
      desc: 'Your downloaded files. Nothing here is automatic — pick individually.', totalKb: 6_800_000,
      items: [
        { name: 'ubuntu-24.04.iso', kb: 5_200_000, path: '/Users/alex/Downloads/ubuntu-24.04.iso', running: false, runVia: '' },
        { name: 'Xcode_16.dmg', kb: 1_400_000, path: '/Users/alex/Downloads/Xcode_16.dmg', running: false, runVia: '' },
        { name: 'dataset.zip', kb: 200_000, path: '/Users/alex/Downloads/dataset.zip', running: false, runVia: '' },
      ] },
    { id: 'containers', title: 'Containers  (sandboxed app data)', risk: 'review',
      desc: 'Sandboxed apps keep settings, state and sometimes documents here. Removing one resets that app.', totalKb: 3_200_000,
      items: [
        { name: 'Messaging app', kb: 1_900_000, path: '/Users/alex/Library/Containers/com.example.messages', running: true, runVia: 'messages' },
        { name: 'Notes app', kb: 780_000, path: '/Users/alex/Library/Containers/com.example.notes', running: false, runVia: '' },
      ] },
  ],
  largeFiles: [
    { name: 'ubuntu-24.04.iso', kb: 5_200_000, path: '/Users/alex/Downloads/ubuntu-24.04.iso' },
    { name: 'db-backup-2024.sql', kb: 3_400_000, path: '/Users/alex/backups/db-backup-2024.sql' },
    { name: 'screen-recording.mov', kb: 2_600_000, path: '/Users/alex/Movies/screen-recording.mov' },
    { name: 'Xcode_16.dmg', kb: 1_400_000, path: '/Users/alex/Downloads/Xcode_16.dmg' },
    { name: 'project-archive.zip', kb: 900_000, path: '/Users/alex/Documents/project-archive.zip' },
  ],
};

// ---------- fs helpers ----------
function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function listChildren(dir) {
  try { return fs.readdirSync(dir).map(n => path.join(dir, n)); } catch { return []; }
}
function childrenOfAll(dirs) { return dirs.flatMap(listChildren); }
function existing(paths) { return paths.filter(exists); }

// ---------- category definitions ----------
// These are GENERIC macOS user-domain locations, not tied to any one machine.
// All paths live under ~/Library, ~/ or $TMPDIR, which are stable across macOS
// versions (Monterey → Sequoia and beyond). Any category that resolves to zero
// items on a given Mac is dropped from the scan, so a machine only ever sees the
// groups that actually apply to it (no Xcode installed → no Xcode groups, etc.).
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
  { id: 'saved-state', title: 'Saved application state', risk: 'safe', run: true,
    desc: 'Saved window/session state (~/Library/Saved Application State). Rebuilt as you use apps.',
    collect: () => listChildren(j('Library/Saved Application State')) },
  { id: 'containers', title: 'Containers  (sandboxed app data)', risk: 'review', run: true,
    desc: 'Sandboxed apps keep settings, state and sometimes documents here. Removing one resets that app — review before selecting.',
    collect: () => listChildren(j('Library/Containers')) },
  { id: 'dev-caches', title: 'Developer build caches', risk: 'safe',
    desc: 'Package-manager and build caches (npm, Yarn, pnpm, Gradle, Cargo, Go, CocoaPods, pip) and Xcode DerivedData. Re-downloaded or rebuilt on demand.',
    collect: () => existing([
      j('.npm/_cacache'), j('.yarn/cache'), j('Library/Caches/Yarn'),
      j('Library/pnpm/store'), j('.pnpm-store'),
      j('.gradle/caches'), j('.gradle/wrapper'),
      j('.cargo/registry'), j('go/pkg/mod'),
      j('Library/Caches/pip'), j('Library/Caches/CocoaPods'), j('.cocoapods/repos'),
      j('.cache'),
      j('Library/Developer/Xcode/DerivedData'), j('Library/Developer/CoreSimulator/Caches'),
    ]) },
  { id: 'maven', title: 'Maven repository  (~/.m2)', risk: 'review', lazy: true,
    desc: 'Cached Java/Maven dependencies. Frees a lot, but every project re-downloads its dependencies on the next build (slow, needs network). Remove only if you no longer build those projects. (Size is measured in the background so the scan stays fast.)',
    collect: () => existing([j('.m2/repository')]) },
  { id: 'xcode', title: 'Xcode device support & simulators', risk: 'review',
    desc: 'Per-OS debug symbols, archived builds and simulator devices. Regenerated by Xcode when needed.',
    collect: () => childrenOfAll([
      j('Library/Developer/Xcode/iOS DeviceSupport'),
      j('Library/Developer/Xcode/watchOS DeviceSupport'),
      j('Library/Developer/Xcode/tvOS DeviceSupport'),
      j('Library/Developer/Xcode/Archives'),
      j('Library/Developer/CoreSimulator/Devices'),
    ]) },
  { id: 'ios-backups', title: 'iOS / iPadOS device backups', risk: 'review',
    desc: 'Local backups of iPhones/iPads (~/Library/Application Support/MobileSync). Often very large — keep only if you rely on local backups.',
    collect: () => listChildren(j('Library/Application Support/MobileSync/Backup')) },
  { id: 'app-support', title: 'Application Support  (real app data!)', risk: 'review', run: true,
    desc: 'Each app keeps its settings, databases and saved files here. Deleting a folder resets or WIPES that app — not junk, so review carefully. (Big individual files inside show up under Large files below for targeted cleanup.)',
    collect: () => listChildren(j('Library/Application Support')).filter(p => path.basename(p) !== 'MobileSync') },
  { id: 'user-temp', title: 'User temp  ($TMPDIR)', risk: 'review',
    desc: 'Per-user temp files. A running app may be using some — close apps first.',
    collect: () => listChildren(os.tmpdir()) },
  { id: 'downloads', title: 'Downloads  (review each!)', risk: 'review',
    desc: 'Your downloaded files. Nothing here is automatic — pick individually.',
    collect: () => listChildren(j('Downloads')) },
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

function duSizesAsync(paths) {
  return new Promise(resolve => duSizes(paths, resolve));
}

// ---------- large files ----------
// Paths surfaced by the most recent large-file lookup, so they can be trashed
// without re-walking the disk on every clean request.
let LARGE_CACHE = new Set();
const LARGE_MIN = 512 * 1024 * 1024; // 512 MB

function statFiles(paths) {
  const files = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) files.push({ path: p, name: path.basename(p), kb: Math.round(st.size / 1024) });
    } catch {}
  }
  files.sort((a, b) => b.kb - a.kb);
  return files.slice(0, 40);
}
function spotlightOn() {
  try { return /enabled/i.test(String(execFileSync('mdutil', ['-s', '/'], { timeout: 4000 }))); }
  catch { return false; }
}
// Fast path: Spotlight index (instant when enabled — the default on macOS).
function largeFilesSpotlight() {
  let out = '';
  try { out = String(execFileSync('mdfind', ['-onlyin', HOME, `kMDItemFSSize > ${LARGE_MIN}`],
    { maxBuffer: 16 << 20, timeout: 8000 })); } catch {}
  return statFiles(out.split('\n'));
}
// Opt-in deep path: walk the disk with `find`, pruning high-file-count dirs that
// never hold big files. Time-boxed; returns partial results if it runs long.
function largeFilesDeep() {
  const args = [HOME,
    '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', 'Caches',
    '-o', '-name', '*.photoslibrary',
    '-o', '-path', `${HOME}/.m2`, '-o', '-path', `${HOME}/.gradle`, '-o', '-path', `${HOME}/.npm`,
    '-o', '-path', `${HOME}/go`, '-o', '-path', `${HOME}/.cache`,
    '-o', '-path', `${HOME}/Library/Developer/CoreSimulator`,
    '-o', '-path', `${HOME}/Library/Group Containers`, ')', '-prune',
    '-o', '-type', 'f', '-size', '+512M', '-print'];
  let out = '';
  try { out = String(execFileSync('find', args, { maxBuffer: 32 << 20, timeout: 40000, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch (e) { out = (e.stdout && e.stdout.toString()) || ''; } // partial on timeout
  return statFiles(out.split('\n'));
}

// ---------- scan ----------
// Emits a checklist the UI renders: one step per thing being scanned.
//   {type:'plan', steps:[{key,label}]}   {type:'start', key}   {type:'done', key}
async function collectScan(emit) {
  const say = o => { if (emit) emit(o); };

  if (DEMO) {
    const steps = [{ key: 'running', label: 'Detecting running apps' },
      ...DEMO_DATA.categories.map(c => ({ key: c.id, label: c.title.replace(/\s+/g, ' ').trim() })),
      { key: 'large', label: 'Finding large files' }];
    say({ type: 'plan', steps });
    steps.forEach(s => { say({ type: 'start', key: s.key }); say({ type: 'done', key: s.key }); });
    LARGE_CACHE = new Set(DEMO_DATA.largeFiles.map(f => f.path));
    return DEMO_DATA;
  }

  // Only groups that actually have items appear — in the checklist and the result.
  const catDefs = CATEGORIES.map(c => ({ cat: c, items: existing(c.collect()) }))
    .filter(d => d.items.length > 0);

  const steps = [{ key: 'running', label: 'Detecting running apps' },
    ...catDefs.map(d => ({ key: d.cat.id, label: d.cat.title.replace(/\s+/g, ' ').trim() })),
    { key: 'large', label: 'Finding large files' }];
  say({ type: 'plan', steps });

  say({ type: 'start', key: 'running' });
  const running = runningApps();
  say({ type: 'done', key: 'running' });

  // Size every group concurrently — they all start, then tick off as each finishes.
  catDefs.forEach(d => say({ type: 'start', key: d.cat.id }));
  const built = await Promise.all(catDefs.map(async ({ cat, items }) => {
    let group;
    if (cat.lazy) {   // don't walk it now — the client measures it in the background
      group = {
        id: cat.id, title: cat.title, risk: cat.risk, desc: cat.desc, lazy: true, totalKb: null,
        items: items.map(p => ({ path: p, name: path.basename(p), kb: null, lazy: true, running: false, runVia: '' })),
      };
    } else {
      const sizes = await duSizesAsync(items);
      const kb = p => sizes.get(p) || 0;
      group = {
        id: cat.id, title: cat.title, risk: cat.risk, desc: cat.desc,
        totalKb: items.reduce((s, p) => s + kb(p), 0),
        items: items.map(p => {
          const name = path.basename(p);
          const run = cat.run ? itemRunning(name, running) : null;
          return { path: p, name, kb: kb(p), running: !!run, runVia: run || '' };
        }).sort((a, b) => b.kb - a.kb),
      };
    }
    say({ type: 'done', key: cat.id });
    return group;
  }));

  // safe groups first, then review; within a tier, largest first
  const rank = r => (r === 'safe' ? 0 : 1);
  built.sort((a, b) => rank(a.risk) - rank(b.risk) || (b.totalKb || 0) - (a.totalKb || 0));

  say({ type: 'start', key: 'large' });
  const large = largeFilesSpotlight();
  LARGE_CACHE = new Set(large.map(f => f.path));
  say({ type: 'done', key: 'large' });

  return { generatedAt: new Date().toISOString(), home: HOME, categories: built,
           largeFiles: large, spotlight: spotlightOn(), mysqlAvailable: !!mysqlBin() };
}

function allowedPaths() {
  const set = new Set();
  for (const c of CATEGORIES) for (const p of existing(c.collect())) set.add(p);
  for (const p of LARGE_CACHE) set.add(p);   // allow trashing surfaced large files
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
    collectScan().then(d => sendJSON(res, 200, d))
      .catch(e => sendJSON(res, 500, { error: String(e && e.message || e) }));
    return;
  }

  if (req.method === 'GET' && url === '/api/scan/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    collectScan(p => send('progress', p))
      .then(d => { send('result', d); res.end(); })
      .catch(e => { send('scanerror', { error: String(e && e.message || e) }); res.end(); });
    return;
  }

  if (req.method === 'POST' && url === '/api/size') {
    return readBody(req, data => {
      if (!data || !Array.isArray(data.paths)) return sendJSON(res, 400, { error: 'paths[] required' });
      const allowed = allowedPaths();
      const paths = data.paths.filter(p => typeof p === 'string' && allowed.has(p));
      duSizes(paths, m => sendJSON(res, 200, { sizes: Object.fromEntries(m) }));
    });
  }

  if (req.method === 'GET' && url === '/api/large-files/deep') {
    if (DEMO) return sendJSON(res, 200, { ok: true, files: DEMO_DATA.largeFiles });
    const files = largeFilesDeep();
    for (const f of files) LARGE_CACHE.add(f.path);
    return sendJSON(res, 200, { ok: true, files });
  }

  if (req.method === 'POST' && url === '/api/reveal') {
    return readBody(req, data => {
      const p = data && data.path;
      if (typeof p !== 'string' || !exists(p)) return sendJSON(res, 400, { ok: false, error: 'path not found' });
      execFile('open', ['-R', p]);   // reveal in Finder (read-only)
      sendJSON(res, 200, { ok: true });
    });
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
