'use strict';
// The whole server: one function, routed by path. Every route except sign-in, config, the Shortcut log and the
// timed notes needs a signed-in session, and every query is limited to that person's own rows.
const crypto = require('crypto');
const { SignJWT, jwtVerify, createRemoteJWKSet } = require('jose');
const webpush = require('web-push');
const { q } = require('../lib/db');
const { numbers } = require('../lib/compute');
const notes = require('../lib/notes');

const env = (k) => process.env[k] || '';
const SITE = () => env('SITE_URL') || 'https://my-spending-two.vercel.app';
const enc = new TextEncoder();
const sessionKey = () => enc.encode(env('SESSION_SECRET'));
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_BODY = 16 * 1024;
const DAY = 86400000;

// ---- small helpers -------------------------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const send = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};

const readBody = async (req, limit) => {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) return req.body;
  let text = '';
  if (typeof req.body === 'string') text = req.body;
  else if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8');
  else {
    text = await new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > (limit || MAX_BODY)) { reject(new HttpError(413, 'Too much data')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  if (text.length > (limit || MAX_BODY)) fail(413, 'Too much data');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) { return { text }; }
};

const bearer = (req) => {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
};

const iso = (v) => new Date(v).toISOString();
const issueOf = (r) => ({ number: Number(r.id), title: r.title, body: r.body, state: r.state, created_at: iso(r.created_at) });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- sessions -------------------------------------------------------------------------------------------------
const makeSession = (user) => new SignJWT({ v: user.session_version })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(user.id)
  .setIssuedAt()
  .setExpirationTime('365d')
  .sign(sessionKey());

const signedIn = async (req) => {
  const token = bearer(req);
  if (!token) fail(401, 'Please sign in');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, sessionKey(), { algorithms: ['HS256'] }));
  } catch (e) {
    fail(401, 'Please sign in again');
  }
  const rows = await q('select * from users where id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || user.session_version !== payload.v) fail(401, 'Please sign in again');
  return user;
};

// ---- Google sign-in -------------------------------------------------------------------------------------------
let googleKeys = null;
let verifyGoogle = async (credential) => {
  if (!env('GOOGLE_CLIENT_ID')) fail(503, 'Google sign-in is not set up yet');
  if (!googleKeys) googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  try {
    const { payload } = await jwtVerify(credential, googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env('GOOGLE_CLIENT_ID')
    });
    return payload;
  } catch (e) {
    fail(401, 'Google sign-in could not be checked. Try again.');
  }
};

// ---- the Shortcut's setup code ----------------------------------------------------------------------------------
// Kept hashed for checking, and encrypted so the app can show it again for setting up another automation.
const codeKey = () => crypto.createHash('sha256').update('setup-code:' + env('SESSION_SECRET')).digest();
const seal = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', codeKey(), iv);
  const out = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
};
const unseal = (b64) => {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', codeKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
const newCode = async (user) => {
  const code = 'sp_' + crypto.randomBytes(24).toString('base64url');
  await q('update users set key_hash = $2, key_enc = $3 where id = $1', [user.id, sha(code), seal(code)]);
  return code;
};

// ---- turning a Shortcut's fields into a purchase ----------------------------------------------------------------
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max || 160);
const pick = (o, ...names) => {
  const keys = Object.keys(o || {});
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n);
    if (k !== undefined && clean(o[k]) !== '') return o[k];
  }
  return '';
};

const fromShortcut = (input) => {
  const o = input && typeof input === 'object' ? input : {};
  const date = clean(pick(o, 'date', 'when', 'time'), 40) || new Date().toISOString();
  const wTitle = pick(o, 'title', 'notificationtitle');
  const wSub = pick(o, 'subtitle', 'notificationsubtitle');
  const wBody = pick(o, 'body', 'notificationbody', 'text', 'message');
  const isWallet = /wallet|notification/i.test(String(pick(o, 'source', 'type'))) || (!pick(o, 'merchant', 'amount') && (wTitle || wSub || wBody));
  if (isWallet) {
    if (!(wTitle || wSub || wBody)) fail(400, 'The Wallet alert had no text');
    return {
      title: 'Spending - wallet alert',
      body: ['Source: wallet-notification', 'Date: ' + date, 'Title: ' + clean(wTitle), 'Subtitle: ' + clean(wSub), 'Body: ' + clean(wBody, 300)].join('\n')
    };
  }
  const merchant = clean(pick(o, 'merchant', 'store', 'name'));
  const amount = clean(pick(o, 'amount', 'total', 'price'), 40);
  if (!amount) fail(400, 'No amount was sent');
  const card = clean(pick(o, 'card', 'pass', 'paymentcard'));
  const category = clean(pick(o, 'category'), 60);
  const shownAmount = /\$/.test(amount) ? amount : '$' + amount;
  return {
    title: 'Spending - ' + shownAmount + ' - ' + date.slice(0, 10) + (category ? ' - ' + category : ''),
    body: ['Date: ' + date, 'Merchant: ' + merchant, 'Amount: ' + shownAmount, 'Card: ' + card, 'Category: ' + category].join('\n')
  };
};

// ---- push -------------------------------------------------------------------------------------------------------
const pushReady = () => {
  if (!env('VAPID_PUBLIC_KEY') || !env('VAPID_PRIVATE_KEY')) return false;
  try {
    webpush.setVapidDetails(SITE(), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
    return true;
  } catch (e) {
    console.error('push keys are not usable:', e.message);
    return false;
  }
};
let pushSender = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' });

const pushTo = async (userId, message, only) => {
  if (!pushReady()) return 0;
  const devices = only ? [only] : await q('select * from devices where user_id = $1', [userId]);
  let sent = 0;
  for (const d of devices) {
    try {
      await pushSender({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify({ ...message, url: SITE() + '/' }));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await q('delete from devices where endpoint = $1', [d.endpoint]);
    }
  }
  return sent;
};

// ---- numbers for one person ------------------------------------------------------------------------------------
const recentIssues = async (userId) => {
  const rows = await q("select id, title, body, state, created_at from purchases where user_id = $1 and state = 'open' and created_at > $2 order by created_at desc limit 3000", [userId, new Date(Date.now() - 29 * DAY).toISOString()]);
  return rows.map(issueOf);
};
const numbersFor = async (user) => numbers(await recentIssues(user.id), user.tz, Date.now());
const limitOf = (user) => Number(user.daily_limit) || 0;

// After a new purchase: push an alert if needed and return a short line for the Shortcut to show.
const afterPurchase = async (user, purchaseId) => {
  const n = await numbersFor(user);
  const msg = notes.alertFor(n, purchaseId, limitOf(user));
  const message = notes.quickLine(n, limitOf(user));
  if (msg) {
    try { await pushTo(user.id, msg); } catch (e) { console.error('alert push failed:', e && e.message); }
  }
  return { message, alert: msg ? msg.title : null };
};

const addPurchase = async (user, title, body, createdAt) => {
  const today = await q("select count(*)::int as n from purchases where user_id = $1 and created_at > $2", [user.id, new Date(Date.now() - DAY).toISOString()]);
  if (today[0] && today[0].n >= 300) fail(429, 'Too many purchases today');
  const rows = await q('insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4) returning id, title, body, state, created_at', [user.id, clean(title, 200), String(body).slice(0, 2000), createdAt]);
  return rows[0];
};

const validDate = (v) => {
  const t = Date.parse(v);
  if (isNaN(t)) return new Date().toISOString();
  return new Date(Math.min(Math.max(t, Date.now() - 30 * DAY), Date.now() + 3600000)).toISOString();
};

// ---- routes -----------------------------------------------------------------------------------------------------
const routes = {
  'GET config': async () => ({ googleClientId: env('GOOGLE_CLIENT_ID'), vapidPublicKey: env('VAPID_PUBLIC_KEY') }),

  'POST auth/google': async (req) => {
    const b = await readBody(req);
    const credential = String(b.credential || '');
    if (!credential) fail(400, 'No Google sign-in was sent');
    const g = await verifyGoogle(credential);
    if (!g || !g.sub || !g.email || g.email_verified === false) fail(401, 'Google did not confirm this account');
    const rows = await q(
      `insert into users (google_sub, email, name) values ($1, $2, $3)
       on conflict (google_sub) do update set email = excluded.email, name = excluded.name
       returning *`, [String(g.sub), String(g.email).slice(0, 200), String(g.name || '').slice(0, 200)]);
    const user = rows[0];
    return { session: await makeSession(user), email: user.email, name: user.name, isNew: !user.key_hash };
  },

  'GET me': async (req) => {
    const u = await signedIn(req);
    const devices = await q('select count(*)::int as n from devices where user_id = $1', [u.id]);
    return { email: u.email, name: u.name, dailyLimit: limitOf(u), tz: u.tz, hasCode: !!u.key_hash, devices: devices[0] ? devices[0].n : 0, vapidPublicKey: env('VAPID_PUBLIC_KEY') };
  },

  'PUT me': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    if (b.tz !== undefined) {
      const tz = String(b.tz).slice(0, 64);
      try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch (e) { fail(400, 'That time zone is not known'); }
      await q('update users set tz = $2 where id = $1', [u.id, tz]);
    }
    return { ok: true };
  },

  'PUT limit': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const v = Math.round(Number(b.dailyLimit) * 100) / 100;
    if (!(v >= 0) || v > 100000) fail(400, 'The limit must be between $0 and $100,000');
    await q('update users set daily_limit = $2 where id = $1', [u.id, v]);
    return { dailyLimit: v };
  },

  'GET setup-code': async (req) => {
    const u = await signedIn(req);
    if (u.key_enc) {
      try { return { code: unseal(u.key_enc) }; } catch (e) { /* make a new one below */ }
    }
    return { code: await newCode(u) };
  },

  'POST setup-code': async (req) => {
    const u = await signedIn(req);
    return { code: await newCode(u) };
  },

  'GET purchases': async (req) => {
    const u = await signedIn(req);
    return recentIssues(u.id);
  },

  'POST purchases': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    if (!b.title || !b.body) fail(400, 'A purchase needs a title and details');
    const row = await addPurchase(u, b.title, b.body, validDate(b.created_at));
    const after = await afterPurchase(u, row.id).catch(() => ({}));
    return { ...issueOf(row), message: after.message };
  },

  'GET purchases/:id': async (req, id) => {
    const u = await signedIn(req);
    const rows = await q('select id, title, body, state, created_at from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!rows[0]) fail(404, 'That purchase was not found');
    return issueOf(rows[0]);
  },

  'PATCH purchases/:id': async (req, id) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const rows = await q('select * from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!rows[0]) fail(404, 'That purchase was not found');
    const cur = rows[0];
    const title = b.title !== undefined ? clean(b.title, 200) : cur.title;
    const body = b.body !== undefined ? String(b.body).slice(0, 2000) : cur.body;
    const state = b.state === 'closed' || b.state === 'open' ? b.state : cur.state;
    const out = await q('update purchases set title = $3, body = $4, state = $5, updated_at = now() where id = $1 and user_id = $2 returning id, title, body, state, created_at', [id, u.id, title, body, state]);
    return issueOf(out[0]);
  },

  // The Shortcut sends each purchase here, with its setup code instead of a session.
  'POST log': async (req) => {
    const code = bearer(req) || String(req.headers['x-setup-code'] || '');
    const b = await readBody(req);
    const given = code || String(b.code || b.setupCode || '');
    if (!/^sp_[A-Za-z0-9_-]{20,}$/.test(given)) fail(401, 'This Shortcut needs your setup code from the app');
    const rows = await q('select * from users where key_hash = $1', [sha(given)]);
    const u = rows[0];
    if (!u) fail(401, 'That setup code is not valid any more. Copy the new one from the app.');
    const p = fromShortcut(b);
    const row = await addPurchase(u, p.title, p.body, new Date().toISOString());
    const after = await afterPurchase(u, row.id).catch(() => ({ message: 'Logged.' }));
    return { ok: true, id: Number(row.id), message: after.message, alert: after.alert || null };
  },

  'POST devices': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const s = b.subscription || {};
    let host = '';
    try { host = new URL(s.endpoint).hostname; } catch (e) { /* checked below */ }
    if (!String(s.endpoint || '').startsWith('https://') || !PUSH_HOSTS.some((re) => re.test(host))) fail(400, 'That is not a phone push address');
    if (!s.keys || !s.keys.p256dh || !s.keys.auth) fail(400, 'The push keys are missing');
    const d = { endpoint: String(s.endpoint).slice(0, 1000), p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 200) };
    await q(`insert into devices (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
             on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`, [u.id, d.endpoint, d.p256dh, d.auth]);
    await pushTo(u.id, { title: 'Spending alerts are on', body: 'You will get a note each morning with what you can spend, an alert when you go over your limit, and a reminder each night at 9.' }, d);
    return { ok: true };
  },

  'DELETE devices': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    await q('delete from devices where user_id = $1 and endpoint = $2', [u.id, String(b.endpoint || '')]);
    return { ok: true };
  },

  'POST devices/test': async (req) => {
    const u = await signedIn(req);
    return { sent: await pushTo(u.id, { title: 'Test alert', body: 'If you can read this, spending alerts are working.' }) };
  },

  'POST signout-all': async (req) => {
    const u = await signedIn(req);
    await q('update users set session_version = session_version + 1 where id = $1', [u.id]);
    return { ok: true };
  },

  'DELETE account': async (req) => {
    const u = await signedIn(req);
    await q('delete from users where id = $1', [u.id]);
    return { ok: true };
  },

  // The morning and evening notes. Vercel calls this on a schedule with the cron secret.
  'GET cron': async (req) => {
    if (!env('CRON_SECRET') || bearer(req) !== env('CRON_SECRET')) fail(401, 'Not allowed');
    const users = await q('select u.* from users u where exists (select 1 from devices d where d.user_id = u.id)');
    let sent = 0;
    for (const u of users) {
      try {
        const n = await numbersFor(u);
        const kind = n.hour >= 8 && n.hour <= 10 ? 'morning' : n.hour >= 21 && n.hour <= 23 ? 'evening' : '';
        if (!kind) continue;
        const fresh = await q('insert into notes_sent (user_id, kind, day) values ($1, $2, $3) on conflict do nothing returning day', [u.id, kind, n.today]);
        if (!fresh.length) continue;
        const m = kind === 'morning' ? notes.morningFor(n, limitOf(u)) : notes.eveningFor(n, limitOf(u));
        sent += await pushTo(u.id, m);
      } catch (e) {
        console.error('note failed for a user', e && e.message);
      }
    }
    await q("delete from notes_sent where day < $1", [new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10)]);
    return { users: users.length, sent };
  },

  // One-time move of existing purchases into an account, by the owner of this server.
  'POST admin/import': async (req) => {
    if (!env('ADMIN_SECRET') || bearer(req) !== env('ADMIN_SECRET')) fail(401, 'Not allowed');
    const b = await readBody(req, 512 * 1024);
    const users = await q('select * from users where lower(email) = lower($1)', [String(b.email || '')]);
    if (!users[0]) fail(404, 'No account with that email has signed in yet');
    let added = 0;
    for (const i of (Array.isArray(b.issues) ? b.issues : []).slice(0, 2000)) {
      if (!i.title || !i.body) continue;
      await q('insert into purchases (user_id, title, body, state, created_at) values ($1, $2, $3, $4, $5)', [users[0].id, clean(i.title, 200), String(i.body).slice(0, 2000), i.state === 'closed' ? 'closed' : 'open', isNaN(Date.parse(i.created_at)) ? new Date().toISOString() : i.created_at]);
      added++;
    }
    if (b.dailyLimit !== undefined) await q('update users set daily_limit = $2 where id = $1', [users[0].id, Number(b.dailyLimit) || 0]);
    return { added };
  }
};
routes['POST cron'] = routes['GET cron'];

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let route = url.searchParams.get('route');
    if (route === null) route = url.pathname.replace(/^\/api\/?/, '');
    route = route.replace(/^\/+|\/+$/g, '');
    let key = req.method + ' ' + route;
    let arg;
    const m = /^purchases\/(\d{1,18})$/.exec(route);
    if (m) {
      key = req.method + ' purchases/:id';
      arg = m[1];
    }
    const fn = routes[key];
    if (!fn) return send(res, 404, { error: 'Not found' });
    const out = await fn(req, arg);
    return send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
};

module.exports = handler;
module.exports._test = {
  setGoogleVerifier: (fn) => { verifyGoogle = fn; },
  setPushSender: (fn) => { pushSender = fn; },
  fromShortcut
};
