'use strict';
/*
 * Tandra Asset Hub — web server.
 * Serves the website (public/index.html), the JSON API and uploaded files.
 * Data lives in Postgres when DATABASE_URL is set (Neon), otherwise in ./data (local testing only).
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, '..', 'public');
const STAFF_EMAIL = String(process.env.STAFF_EMAIL || 'admin@tandrahub.com').trim().toLowerCase();
const STAFF_PASSWORD = String(process.env.STAFF_PASSWORD || '');
const COLS = ['estates', 'users', 'apps', 'notices', 'media', 'inspections', 'broadcasts', 'subscribers'];
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
const MAX_JSON = 4 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024;

/* ---------------- storage ---------------- */
function fileStore() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const dbf = path.join(dir, 'db.json');
  let db = {}; try { db = JSON.parse(fs.readFileSync(dbf, 'utf8')); } catch (e) {}
  let t = null; const flush = () => { clearTimeout(t); t = setTimeout(() => fs.writeFileSync(dbf + '.tmp', JSON.stringify(db)) || fs.renameSync(dbf + '.tmp', dbf), 50); };
  return {
    kind: 'files (local testing only)',
    async init() {},
    async loadAll() { const out = []; for (const c in db) for (const id in db[c]) out.push({ col: c, id, data: db[c][id] }); return out; },
    async put(col, id, data) { (db[col] = db[col] || {})[id] = data; flush(); },
    async del(col, id) { if (db[col]) delete db[col][id]; flush(); },
    async putFile(id, meta, buf) { fs.writeFileSync(path.join(dir, 'files', id), buf); await this.put('_files', id, meta); },
    async getFile(id) { const m = db._files && db._files[id]; if (!m) return null; try { return { ...m, data: fs.readFileSync(path.join(dir, 'files', id)) }; } catch (e) { return null; } },
  };
}
function pgStore(url) {
  const { Pool } = require('pg');
  const clean = url.split('?')[0];
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(clean);
  const pool = new Pool({ connectionString: clean, ssl: local ? false : { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 20000 });
  pool.on('error', e => console.error('db pool error', e.message));
  const q = (text, params) => pool.query(text, params);
  return {
    kind: 'postgres',
    async init() {
      await q(`create table if not exists docs (col text not null, id text not null, data jsonb not null, updated timestamptz not null default now(), primary key (col, id))`);
      await q(`create table if not exists files (id text primary key, name text, type text, size integer, data bytea not null, created timestamptz not null default now())`);
    },
    async loadAll() { return (await q('select col, id, data from docs')).rows; },
    async put(col, id, data) { await q('insert into docs (col, id, data) values ($1, $2, $3) on conflict (col, id) do update set data = excluded.data, updated = now()', [col, id, JSON.stringify(data)]); },
    async del(col, id) { await q('delete from docs where col = $1 and id = $2', [col, id]); },
    async putFile(id, meta, buf) { await q('insert into files (id, name, type, size, data) values ($1, $2, $3, $4, $5)', [id, meta.name, meta.type, buf.length, buf]); },
    async getFile(id) { const r = await q('select name, type, data from files where id = $1', [id]); return r.rows[0] || null; },
  };
}
const store = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : fileStore();

/* ---------------- in-memory state (one server instance) ---------------- */
const S = { settings: null, log: [], sessions: {} };
COLS.forEach(c => (S[c] = new Map()));
const now = () => new Date().toISOString();
const rid = (n = 18) => crypto.randomBytes(n).toString('base64url');
const code = n => Array.from(crypto.randomBytes(n), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const clip = (s, n = 500) => String(s == null ? '' : s).slice(0, n);
const okId = id => typeof id === 'string' && /^[\w.@+-]{1,80}$/.test(id);
const persist = (col, id, data) => store.put(col, id, data).catch(e => console.error('save failed', col, id, e.message));

async function loadState() {
  await store.init();
  const rows = await store.loadAll();
  for (const r of rows) {
    if (COLS.includes(r.col)) S[r.col].set(r.id, r.data);
    else if (r.col === 'meta' && r.id === 'settings') S.settings = r.data;
    else if (r.col === 'meta' && r.id === 'log') S.log = r.data;
    else if (r.col === 'sessions') S.sessions[r.id] = r.data;
  }
  if (!S.settings) { // first run: load the real estates and settings
    S.settings = SEED.settings; await persist('meta', 'settings', S.settings);
    for (const e of SEED.estates) { S.estates.set(e.id, e); await persist('estates', e.id, e); }
    for (const m of SEED.media) { S.media.set(m.id, m); await persist('media', m.id, m); }
    console.log('Seeded', SEED.estates.length, 'estates');
  }
}
let logT = null;
function addLog(x) { S.log.unshift({ t: now(), x: clip(x, 240) }); S.log = S.log.slice(0, 500); clearTimeout(logT); logT = setTimeout(() => persist('meta', 'log', S.log), 400); }

/* ---------------- passwords + sessions ---------------- */
const hashPass = p => { const salt = crypto.randomBytes(16).toString('hex'); return 'scrypt$' + salt + '$' + crypto.scryptSync(String(p), salt, 64).toString('hex'); };
const checkPass = (p, h) => { if (!h || !h.startsWith('scrypt$')) return false; const [, salt, hex] = h.split('$'); const a = crypto.scryptSync(String(p), salt, 64), b = Buffer.from(hex, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function newSession(role, uid) { const t = rid(24), s = { role, uid: uid || null, created: now() }; S.sessions[t] = s; await persist('sessions', t, s); return t; }
function session(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const s = S.sessions[m[1]]; if (!s) return null;
  if (Date.now() - new Date(s.created).getTime() > 60 * 864e5) { delete S.sessions[m[1]]; store.del('sessions', m[1]).catch(() => {}); return null; }
  if (s.role === 'client' && !S.users.has(s.uid)) return null;
  return { ...s, token: m[1] };
}
const userByEmail = em => { em = String(em || '').trim().toLowerCase(); for (const u of S.users.values()) if (String(u.email).toLowerCase() === em) return u; return null; };

/* ---------------- what each person may see ---------------- */
const stripUser = u => { const { ph, ...rest } = u; return { ...rest, pass: '' }; };
const pubSettings = () => { const { staff, ...rest } = S.settings || {}; return rest; };
function view(sess) {
  const role = sess ? sess.role : 'public', uid = sess && sess.uid;
  const all = c => [...S[c].values()];
  const v = { role, me: role === 'client' ? uid : null, settings: pubSettings() };
  if (role === 'staff') {
    COLS.forEach(c => (v[c] = all(c)));
    v.users = v.users.map(stripUser); v.log = S.log.slice(0, 300);
    v.apps.sort((a, b) => String(a.created).localeCompare(String(b.created)));
    return v;
  }
  const mine = role === 'client' ? new Set(all('apps').filter(a => a.u === uid).map(a => a.e)) : new Set();
  v.estates = all('estates').filter(e => e.published || mine.has(e.id));
  v.media = all('media').filter(m => m.published);
  v.users = []; v.apps = []; v.notices = []; v.inspections = []; v.broadcasts = []; v.subscribers = []; v.log = [];
  if (role === 'client') {
    const u = S.users.get(uid); if (u) v.users = [stripUser(u)];
    v.apps = all('apps').filter(a => a.u === uid).sort((a, b) => String(a.created).localeCompare(String(b.created)));
    v.notices = all('notices').filter(n => n.u === uid).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    v.inspections = all('inspections').filter(i => i.u === uid);
  }
  return v;
}

/* ---------------- applying changes ---------------- */
const fileRef = f => f && typeof f === 'object' && typeof f.data === 'string' && (/^\/f\/[\w-]{10,40}$/.test(f.data) || (/^data:image\/(png|jpeg);base64,/.test(f.data) && f.data.length < 400000)) ? { name: clip(f.name, 120), type: clip(f.type, 60), data: f.data } : null;
const smallImg = s => typeof s === 'string' && ((/^data:image\/(png|jpeg);base64,/.test(s) && s.length < 400000) || /^\/f\/[\w-]{10,40}$/.test(s)) ? s : null;
const cleanObj = (o, n = 2000) => { const out = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(0, 120)) { const v = o[k]; if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[clip(k, 40)] = typeof v === 'string' ? clip(v, n) : v; } return out; };
const estPlans = e => (e && e.terms && e.terms.plans && e.terms.plans.length ? e.terms.plans : S.settings.plans);
function nextRef(e) { let n = 0; for (const a of S.apps.values()) { const m = /\/(\d{4,})$/.exec(a.ref || ''); if (m) n = Math.max(n, +m[1]); } return `TAH/${e.code || 'XX'}/${new Date().getFullYear()}/${String(n + 1).padStart(4, '0')}`; }

async function put(col, id, data) { S[col].set(id, data); await persist(col, id, data); }
async function del(col, id) { S[col].delete(id); await store.del(col, id).catch(() => {}); }

async function staffOp(op) {
  const { c, id, d } = op;
  if (!d) return del(c, id);
  if (c === 'users') {
    const cur = S.users.get(id) || {};
    const u = { ...d, id }; delete u.ph;
    if (d.pass) u.ph = hashPass(d.pass); else if (cur.ph) u.ph = cur.ph;
    u.pass = ''; return put('users', id, u);
  }
  return put(c, id, { ...d, ...(c === 'subscribers' ? {} : { id }) });
}

async function clientOp(op, sess) {
  const { c, id, d } = op, uid = sess && sess.role === 'client' ? sess.uid : null;
  if (!d) return; // clients never delete
  if (c === 'subscribers') {
    if (S.subscribers.has(id) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return;
    return put('subscribers', id, { email: clip(d.email, 160), date: now(), source: clip(d.source || 'Newsletter form', 60) });
  }
  if (c === 'inspections') {
    if (S.inspections.has(id) || !S.estates.has(d.e)) return;
    return put('inspections', id, { id, u: uid, name: clip(d.name, 120), phone: clip(d.phone, 40), e: d.e, t: clip(d.t, 40), date: clip(d.date, 12), time: clip(d.time, 8), status: 'requested', created: now() });
  }
  if (!uid) return;
  if (c === 'users' && id === uid) {
    const cur = S.users.get(uid), up = { ...cur };
    for (const k of ['name', 'phone', 'address', 'occupation']) if (typeof d[k] === 'string') up[k] = clip(d[k], 300);
    if (typeof d.email === 'string' && d.email.trim().toLowerCase() !== String(cur.email).toLowerCase()) { const other = userByEmail(d.email); if (!other) up.email = clip(d.email.trim(), 160); }
    up.subscribed = !!d.subscribed;
    if (Array.isArray(d.interests)) up.interests = d.interests.filter(okId).slice(0, 60);
    if (Array.isArray(d.viewed)) up.viewed = d.viewed.filter(okId).slice(0, 100);
    return put('users', uid, up);
  }
  if (c === 'notices') {
    const cur = S.notices.get(id);
    if (cur) { if (cur.u === uid && cur.read !== !!d.read) return put('notices', id, { ...cur, read: !!d.read }); return; }
    if (d.u !== uid) return;
    return put('notices', id, { id, u: uid, title: clip(d.title, 160), body: clip(d.body, 1500), date: now(), ch: Array.isArray(d.ch) ? d.ch.slice(0, 3).map(x => clip(x, 6)) : ['app'], read: !!d.read });
  }
  if (c === 'apps') {
    const cur = S.apps.get(id);
    if (!cur) { // a new application
      const e = S.estates.get(d.e), t = e && (e.types || []).find(x => x.id === d.t);
      if (!t || !t.price || !e.published) return;
      const units = Math.max(1, Math.min(3, Math.round(+d.units || 1)));
      if (t.total - t.sold < units) return;
      const plan = estPlans(e).some(p => p.id === d.plan) ? d.plan : 'outright';
      const files = {}; if (d.files && typeof d.files === 'object') for (const k of Object.keys(d.files).slice(0, 20)) { const f = fileRef(d.files[k]); if (f) files[clip(k, 30)] = f; }
      const form = cleanObj(d.form); if (d.form && Array.isArray(d.form.bens)) form.bens = d.form.bens.slice(0, 10).map(b => ({ name: clip(b && b.name, 120), share: clip(b && b.share, 6) }));
      const app = { id, ref: nextRef(e), u: uid, e: e.id, t: t.id, units, plan, price: t.price, status: 'submitted', created: now(), form, files,
        fee: { amt: S.settings.fee, method: 'bank', paid: false, status: 'pending', date: now(), ref: 'FEE-' + code(4), proof: fileRef(d.fee && d.fee.proof) },
        counted: false, offer: null, payments: [], allocation: null, notes: [], history: [{ t: now(), x: 'Application form submitted with evidence of fee payment' }] };
      addLog(`${form.name || 'A client'} submitted application ${app.ref} for ${t.name}, ${e.name}`);
      return put('apps', id, app);
    }
    if (cur.u !== uid) return;
    const up = JSON.parse(JSON.stringify(cur)); let changed = false;
    if (cur.fee && cur.fee.status === 'rejected' && d.fee && d.fee.status === 'pending' && fileRef(d.fee.proof)) { up.fee.proof = fileRef(d.fee.proof); up.fee.status = 'pending'; up.fee.date = now(); changed = true; }
    if (cur.status === 'offered' && d.status === 'accepted' && d.offer && d.offer.signedAt) {
      up.offer = { ...(cur.offer || {}), signedAt: now(), method: d.offer.method === 'scan' ? 'scan' : 'digital', sig: smallImg(d.offer.sig), photo: smallImg(d.offer.photo), scan: fileRef(d.offer.scan) };
      if (up.offer.method === 'digital' && !up.offer.sig) return; if (up.offer.method === 'scan' && !up.offer.scan) return;
      up.status = 'accepted'; changed = true;
    }
    if (['accepted', 'paying', 'allocated'].includes(up.status) && Array.isArray(d.payments)) {
      const have = new Set(cur.payments.map(p => p.id));
      for (const p of d.payments.slice(-5)) if (p && okId(p.id) && !have.has(p.id)) {
        const amt = Math.round(+p.amt); if (!(amt > 0)) continue;
        up.payments.push({ id: p.id, amt, method: 'physical', date: now(), status: 'pending', ref: 'PAY-' + code(6), proof: fileRef(p.proof), note: clip(p.note, 200) }); changed = true;
      }
    }
    if (Array.isArray(d.history) && d.history.length > cur.history.length) { for (const h of d.history.slice(cur.history.length).slice(0, 5)) up.history.push({ t: now(), x: clip(h && h.x, 200) }); changed = true; }
    if (changed) return put('apps', id, up);
  }
}

/* ---------------- http helpers ---------------- */
const send = (res, code, body, headers = {}) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(s); };
function readBody(req, max) {
  return new Promise((ok, bad) => { const parts = []; let n = 0;
    req.on('data', ch => { n += ch.length; if (n > max) { bad(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else parts.push(ch); });
    req.on('end', () => ok(Buffer.concat(parts))); req.on('error', bad); });
}
const readJSON = async req => { const b = await readBody(req, MAX_JSON); try { return JSON.parse(b.toString('utf8') || '{}'); } catch (e) { throw Object.assign(new Error('bad json'), { code: 400 }); } };
const hits = new Map();
function limited(req, key, n, ms) { const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), k = key + ip, t = Date.now(); const a = (hits.get(k) || []).filter(x => t - x < ms); a.push(t); hits.set(k, a); return a.length > n; }

let INDEX = null;
function loadIndex() {
  const raw = fs.readFileSync(path.join(PUB, 'index.html'));
  INDEX = { raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"' };
}
function serveIndex(req, res) {
  if (req.headers['if-none-match'] === INDEX.etag) { res.writeHead(304); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: INDEX.etag, vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}),
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  res.end(gz ? INDEX.gz : INDEX.raw);
}

/* ---------------- routes ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, M = req.method;
  if (p === '/healthz') return send(res, 200, { ok: true });
  if (M === 'GET' && p.startsWith('/f/')) {
    const id = p.slice(3); if (!/^[\w-]{10,40}$/.test(id)) { res.writeHead(404); return res.end(); }
    const f = await store.getFile(id); if (!f) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': f.type || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="' + String(f.name || 'file').replace(/[^\w.\- ]/g, '_') + '"' });
    return res.end(f.data);
  }
  if (!p.startsWith('/api/')) { if (M !== 'GET' && M !== 'HEAD') { res.writeHead(405); return res.end(); } return serveIndex(req, res); }

  const sess = session(req);
  if (M === 'GET' && p === '/api/state') return send(res, 200, { ok: true, state: view(sess), auth: !!sess });
  if (M === 'GET' && p === '/api/verify') {
    const c = String(url.searchParams.get('code') || '').trim().toUpperCase();
    for (const a of S.apps.values()) if (a.allocation && String(a.allocation.code).toUpperCase() === c) {
      const e = S.estates.get(a.e), t = e && e.types.find(x => x.id === a.t), u = S.users.get(a.u) || {};
      const paid = a.payments.filter(x => x.status === 'confirmed').reduce((s, x) => s + x.amt, 0);
      return send(res, 200, { ok: true, found: true, name: u.name || (a.form && a.form.name) || '', unit: a.allocation.unit, type: t ? t.name : '', estate: e ? e.name : '', location: e ? e.location : '', date: a.allocation.date, onPlan: paid < (t ? t.price : 0) * a.units });
    }
    return send(res, 200, { ok: true, found: false });
  }
  if (M !== 'POST') return send(res, 404, { ok: false, error: 'Not found' });

  if (p === '/api/upload') {
    if (limited(req, 'up', 60, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Too many uploads. Please wait a few minutes.' });
    const type = String(req.headers['content-type'] || '').split(';')[0];
    if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(type)) return send(res, 415, { ok: false, error: 'Please upload a photo (JPG or PNG) or a PDF.' });
    const buf = await readBody(req, MAX_FILE); if (!buf.length) return send(res, 400, { ok: false, error: 'The file is empty.' });
    const id = rid(15), name = clip(decodeURIComponent(String(req.headers['x-file-name'] || 'file')), 120);
    await store.putFile(id, { name, type, size: buf.length }, buf);
    return send(res, 200, { ok: true, url: '/f/' + id, name, type });
  }
  const b = await readJSON(req);
  if (p === '/api/register') {
    if (limited(req, 'reg', 8, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Too many attempts. Please wait a few minutes.' });
    const email = String(b.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { ok: false, error: 'Enter a valid email address.' });
    if (String(b.password || '').length < 6) return send(res, 400, { ok: false, error: 'Use a password of at least 6 characters.' });
    if (userByEmail(email)) return send(res, 409, { ok: false, error: 'An account with this email already exists. Sign in first, then continue.' });
    const u = { id: rid(9), name: clip(b.name, 120), email: clip(email, 160), phone: clip(b.phone, 40), address: clip(b.address, 300), occupation: clip(b.occupation, 120), pass: '', ph: hashPass(b.password), joined: now(), lastLogin: now(), logins: 1, interests: [], viewed: [], subscribed: b.subscribed !== false };
    await put('users', u.id, u); addLog(`${u.name || u.email} created an account`);
    return send(res, 200, { ok: true, token: await newSession('client', u.id) });
  }
  if (p === '/api/login') {
    if (limited(req, 'login', 10, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Too many sign-in attempts. Please wait 10 minutes.' });
    const u = userByEmail(b.email);
    if (!u || !checkPass(b.password, u.ph)) return send(res, 401, { ok: false, error: 'That email and password don’t match. Check them and try again.' });
    const up = { ...u, lastLogin: now(), logins: (u.logins || 0) + 1 }; await put('users', u.id, up); addLog(`${u.name} signed in`);
    return send(res, 200, { ok: true, token: await newSession('client', u.id) });
  }
  if (p === '/api/staff/login') {
    if (limited(req, 'slogin', 8, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Too many sign-in attempts. Please wait 10 minutes.' });
    if (!STAFF_PASSWORD) return send(res, 503, { ok: false, error: 'Staff sign-in is not set up yet. Add STAFF_PASSWORD on the server.' });
    if (!safeEq(String(b.email || '').trim().toLowerCase(), STAFF_EMAIL) || !safeEq(String(b.password || ''), STAFF_PASSWORD)) return send(res, 401, { ok: false, error: 'Wrong staff email or password.' });
    addLog('Staff signed in'); return send(res, 200, { ok: true, token: await newSession('staff') });
  }
  if (p === '/api/forgot') {
    if (limited(req, 'forgot', 5, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Please wait a few minutes before trying again.' });
    const u = userByEmail(b.email); if (u) addLog(`${u.name} asked for a password reset (${u.phone || u.email}) — use “Send password reset” on their client page`);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/view') { const t = String(b.t || ''); for (const e of S.estates.values()) { const ty = (e.types || []).find(x => x.id === t); if (ty) { ty.views = (ty.views || 0) + 1; persist('estates', e.id, e); break; } } return send(res, 200, { ok: true }); }
  if (p === '/api/logout') { if (sess) { delete S.sessions[sess.token]; await store.del('sessions', sess.token).catch(() => {}); } return send(res, 200, { ok: true }); }
  if (p === '/api/password') {
    if (!sess || sess.role !== 'client') return send(res, 401, { ok: false, error: 'Please sign in again.' });
    const u = S.users.get(sess.uid); if (!checkPass(b.cur, u.ph)) return send(res, 400, { ok: false, error: 'Your current password is wrong.' });
    if (String(b.np || '').length < 6) return send(res, 400, { ok: false, error: 'Use a new password of at least 6 characters.' });
    await put('users', u.id, { ...u, ph: hashPass(b.np) }); return send(res, 200, { ok: true });
  }
  if (p === '/api/sync') {
    const ops = Array.isArray(b.ops) ? b.ops.slice(0, 500) : [];
    const staff = sess && sess.role === 'staff';
    if (!staff && limited(req, 'sync', 120, 10 * 60e3)) return send(res, 429, { ok: false, error: 'Too many changes at once. Please wait a moment.' });
    for (const op of ops) {
      if (!op || !COLS.includes(op.c) || !okId(op.id) || (op.d !== null && typeof op.d !== 'object')) continue;
      try { if (staff) await staffOp(op); else await clientOp(op, sess); } catch (e) { console.error('op failed', op.c, op.id, e.message); }
    }
    if (staff && b.settings && typeof b.settings === 'object') { const { staff: _s, ...rest } = b.settings; S.settings = { ...S.settings, ...rest }; await persist('meta', 'settings', S.settings); }
    if (Array.isArray(b.log)) for (const l of b.log.slice(0, staff ? 30 : 5).reverse()) if (l && l.x) addLog(l.x);
    return send(res, 200, { ok: true, state: view(sess) });
  }
  return send(res, 404, { ok: false, error: 'Not found' });
}

loadIndex();
loadState().then(() => {
  http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { ok: false, error: e.code === 413 ? 'That file is too large (8 MB max).' : 'Something went wrong. Please try again.' }); }))
    .listen(PORT, () => console.log(`Tandra Asset Hub on :${PORT} · storage: ${store.kind} · staff login ${STAFF_PASSWORD ? 'on' : 'OFF (set STAFF_PASSWORD)'}`));
}).catch(e => { console.error('Could not start:', e); process.exit(1); });
