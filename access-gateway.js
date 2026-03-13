#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const ROOT = path.resolve(__dirname, '..');
const CODES_PATH = process.env.ACCESS_CODES_JSON || path.join(__dirname, 'access-codes.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const defaultCodes = [
  { code: 'L2-DEMO-2026', tier: 'patreon_l2', label: 'Demo Patreon L2' },
  { code: 'PROMO-GUEST-2026', tier: 'promo', label: 'Demo Promo' },
];

const sessions = new Map();

function loadCodes() {
  try {
    const raw = fs.readFileSync(CODES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // fallback below
  }
  return defaultCodes;
}

let accessCodes = loadCodes();

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').map((s) => s.trim()).filter(Boolean).reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) acc[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
    return acc;
  }, {});
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function createSession(tier) {
  const sid = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(sid, { tier, expiresAt });
  return sid;
}

function createCookie(sid) {
  const sig = sign(sid);
  return `sc_session=${encodeURIComponent(`${sid}.${sig}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function verifyCookie(req) {
  const token = parseCookies(req).sc_session;
  if (!token) return null;
  const [sid, sig] = token.split('.');
  if (!sid || !sig) return null;
  if (sign(sid) !== sig) return null;

  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/access/verify') {
    const session = verifyCookie(req);
    if (!session) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, tier: session.tier });
  }

  if (req.method === 'POST' && req.url === '/api/access/login') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const code = String(data.code || '').trim();
        const found = accessCodes.find((c) => c.code === code);
        if (!found) return json(res, 401, { ok: false, error: 'Invalid access code' });

        const sid = createSession(found.tier);
        return json(res, 200, { ok: true, tier: found.tier }, { 'Set-Cookie': createCookie(sid) });
      } catch {
        return json(res, 400, { ok: false, error: 'Invalid request body' });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/access/reload') {
    accessCodes = loadCodes();
    return json(res, 200, { ok: true, count: accessCodes.length });
  }

  return false;
}

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/side-chain/index.html';
  const target = path.resolve(ROOT, `.${reqPath}`);

  if (!target.startsWith(ROOT)) return notFound(res);

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(target).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const handled = handleApi(req, res);
    if (handled !== false) return;
    return notFound(res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Side-Chain access gateway running on http://0.0.0.0:${PORT}`);
  console.log(`Loaded ${accessCodes.length} access codes (${accessCodes === defaultCodes ? 'default demo list' : 'from file'}).`);
});
