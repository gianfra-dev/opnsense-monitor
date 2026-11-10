'use strict';
// OPNsense Traffic Monitor - zero dependencies (Node >= 18)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let config = readJson(CONFIG_FILE, null);
// stats: { last: {ifaceId: {rx, tx}}, hours: {"YYYY-MM-DD HH": {ifaceId: [rx, tx]}} }
let stats = readJson(STATS_FILE, { last: {}, hours: {} });
let dirty = false;
const status = { lastPoll: null, lastError: null, polling: false };

// ---------- OPNsense client ----------
function normalizeBase(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!h) throw new Error('Indirizzo router mancante');
  if (!/^https?:\/\//i.test(h)) h = 'https://' + h;
  return h;
}

function opnRequest(cfg, apiPath) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(normalizeBase(cfg.host) + apiPath); } catch (e) { return reject(e); }
    const lib = url.protocol === 'http:' ? http : https;
    const auth = Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64');
    const req = lib.request(url, {
      method: 'GET',
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      rejectUnauthorized: cfg.verifyTls === true,
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(new Error('Risposta troppo grande')); });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('Autenticazione rifiutata (controlla API key/secret e privilegi utente)'));
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' da OPNsense'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Risposta non valida (non JSON)')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout di connessione al router')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Connessione rifiutata' : e.message)));
    req.end();
  });
}

// Returns { id: { name, device, rx, tx } }
async function fetchCounters(cfg) {
  const data = await opnRequest(cfg, '/api/diagnostics/traffic/interface');
  const ifs = data.interfaces || {};
  const out = {};
  for (const [id, v] of Object.entries(ifs)) {
    out[id] = {
      name: v.name || id,
      device: v.device || '',
      rx: Number(v['bytes received']) || 0,
      tx: Number(v['bytes transmitted']) || 0,
    };
  }
  if (!Object.keys(out).length) throw new Error('Nessuna interfaccia restituita dal router');
  return out;
}

// ---------- collection ----------
const pad = (n) => String(n).padStart(2, '0');
function hourKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}`;
}

function record(counters, now) {
  const key = hourKey(now);
  const bucket = (stats.hours[key] ||= {});
  for (const ifc of config.interfaces) {
    const cur = counters[ifc.id];
    if (!cur) continue;
    const prev = stats.last[ifc.id];
    if (prev) {
      // counter lower than before => reboot/reset: the new value is traffic since reset
      const dRx = cur.rx >= prev.rx ? cur.rx - prev.rx : cur.rx;
      const dTx = cur.tx >= prev.tx ? cur.tx - prev.tx : cur.tx;
      const b = (bucket[ifc.id] ||= [0, 0]);
      b[0] += dRx;
      b[1] += dTx;
    }
    stats.last[ifc.id] = { rx: cur.rx, tx: cur.tx };
  }
  dirty = true;
}

async function poll() {
  if (!config || status.polling) return;
  status.polling = true;
  try {
    const counters = await fetchCounters(config);
    record(counters, new Date());
    status.lastPoll = new Date().toISOString();
    status.lastError = null;
  } catch (e) {
    status.lastError = e.message;
  } finally {
    status.polling = false;
  }
}

let pollTimer = null;
function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (!config) return;
  const sec = Math.min(Math.max(config.pollSeconds || 30, 5), 600);
  pollTimer = setInterval(poll, sec * 1000);
  poll();
}

setInterval(() => {
  if (dirty) { try { writeJsonAtomic(STATS_FILE, stats); dirty = false; } catch (e) { console.error('save failed', e.message); } }
}, 15000);
function flush() { if (dirty) try { writeJsonAtomic(STATS_FILE, stats); } catch { /* ignore */ } }
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

// ---------- aggregation ----------
function buildSeries(period, count) {
  const now = new Date();
  const labels = []; // {key, label}
  const keyOf = { hour: (d) => hourKey(d), day: (d) => hourKey(d).slice(0, 10), month: (d) => hourKey(d).slice(0, 7) };
  const prefixLen = { hour: 13, day: 10, month: 7 }[period];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    if (period === 'hour') d.setHours(d.getHours() - i, 0, 0, 0);
    else if (period === 'day') d.setDate(d.getDate() - i);
    else { d.setDate(1); d.setMonth(d.getMonth() - i); }
    labels.push(keyOf[period](d));
  }
  const idx = new Map(labels.map((k, i) => [k, i]));
  const ifaces = {};
  for (const ifc of config.interfaces) ifaces[ifc.id] = labels.map(() => [0, 0]);
  for (const [hk, byIf] of Object.entries(stats.hours)) {
    const i = idx.get(hk.slice(0, prefixLen));
    if (i === undefined) continue;
    for (const [id, v] of Object.entries(byIf)) {
      if (!ifaces[id]) continue;
      ifaces[id][i][0] += v[0];
      ifaces[id][i][1] += v[1];
    }
  }
  return { labels, ifaces };
}

function totalsFor(prefix) {
  const t = {};
  for (const ifc of config.interfaces) t[ifc.id] = [0, 0];
  for (const [hk, byIf] of Object.entries(stats.hours)) {
    if (!hk.startsWith(prefix)) continue;
    for (const [id, v] of Object.entries(byIf)) if (t[id]) { t[id][0] += v[0]; t[id][1] += v[1]; }
  }
  return t;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { req.destroy(); reject(new Error('Body troppo grande')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('JSON non valido')); } });
  });
}
function publicConfig() {
  if (!config) return { configured: false };
  const { apiSecret, ...rest } = config;
  return { configured: true, ...rest, hasSecret: !!apiSecret };
}
function sanitizeInterfaces(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Seleziona almeno un\'interfaccia');
  const seen = new Set();
  return list.map((i) => {
    const id = String(i.id || '').trim();
    if (!id || seen.has(id)) throw new Error('Interfaccia non valida o duplicata');
    seen.add(id);
    const role = i.role === 'wan' ? 'wan' : 'lan';
    return { id, name: String(i.name || id).slice(0, 40), role };
  });
}
// merges stored secret when client leaves it blank
function credsFrom(body) {
  const c = {
    host: body.host,
    apiKey: String(body.apiKey || '').trim(),
    apiSecret: body.apiSecret ? String(body.apiSecret) : (config && config.apiSecret) || '',
    verifyTls: body.verifyTls === true,
  };
  if (!c.apiKey || !c.apiSecret) throw new Error('API key e secret sono obbligatori');
  normalizeBase(c.host);
  return c;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/config') return sendJson(res, 200, publicConfig());
    if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, { configured: !!config, ...status });

    if (req.method === 'POST' && p === '/api/interfaces') {
      const creds = credsFrom(await readBody(req));
      const counters = await fetchCounters(creds);
      return sendJson(res, 200, { interfaces: Object.entries(counters).map(([id, v]) => ({ id, name: v.name, device: v.device })) });
    }

    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const creds = credsFrom(body);
      const interfaces = sanitizeInterfaces(body.interfaces);
      const next = { ...creds, host: normalizeBase(creds.host), interfaces, pollSeconds: Math.min(Math.max(parseInt(body.pollSeconds, 10) || 30, 5), 600) };
      const counters = await fetchCounters(next); // validate before saving
      for (const i of interfaces) if (!counters[i.id]) throw new Error(`Interfaccia "${i.id}" non trovata sul router`);
      config = next;
      writeJsonAtomic(CONFIG_FILE, config);
      // drop baselines of interfaces no longer monitored
      for (const id of Object.keys(stats.last)) if (!interfaces.find((i) => i.id === id)) delete stats.last[id];
      dirty = true;
      schedulePolling();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      if (!config) return sendJson(res, 409, { error: 'Non configurato' });
      const period = ['hour', 'day', 'month'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'hour';
      const max = { hour: 168, day: 366, month: 60 }[period];
      const def = { hour: 24, day: 30, month: 12 }[period];
      const count = Math.min(Math.max(parseInt(url.searchParams.get('count'), 10) || def, 1), max);
      const series = buildSeries(period, count);
      const now = new Date();
      const today = hourKey(now).slice(0, 10);
      return sendJson(res, 200, {
        period, interfaces: config.interfaces, ...series,
        totals: { today: totalsFor(today), month: totalsFor(today.slice(0, 7)), hour: totalsFor(hourKey(now)) },
        status,
      });
    }

    if (req.method === 'GET' && p === '/api/export.csv') {
      if (!config) return sendJson(res, 409, { error: 'Non configurato' });
      const rows = ['ora,interfaccia,ruolo,bytes_rx,bytes_tx'];
      for (const hk of Object.keys(stats.hours).sort()) {
        for (const ifc of config.interfaces) {
          const v = stats.hours[hk][ifc.id];
          if (v) rows.push(`${hk}:00,${ifc.name},${ifc.role},${v[0]},${v[1]}`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="traffico.csv"' });
      return res.end(rows.join('\n'));
    }

    if (req.method === 'POST' && p === '/api/reset-data') {
      stats = { last: {}, hours: {} };
      dirty = true;
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (file === '/setup') file = '/setup.html';
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OPNsense Monitor in ascolto su :${PORT} (dati in ${DATA_DIR})`);
  schedulePolling();
});
