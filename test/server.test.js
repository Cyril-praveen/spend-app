// End-to-end tests of the server against an in-memory Postgres. Run: TZ=UTC node test/server.test.js
'use strict';
const assert = require('assert');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db = require('../lib/db');
  db.setTestDb(async (t, p) => (await pg.query(t, p)).rows);

  process.env.SESSION_SECRET = 'test-secret-'.repeat(4);
  process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.CRON_SECRET = 'cron-secret';
  process.env.ADMIN_SECRET = 'admin-secret';
  const wp = require('web-push').generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = wp.publicKey;
  process.env.VAPID_PRIVATE_KEY = wp.privateKey;

  const api = require('../api/index.js');
  const pushes = [];
  api._test.setPushSender(async (sub, payload) => {
    if (sub.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    pushes.push({ to: sub.endpoint, ...JSON.parse(payload) });
  });
  const people = {
    'good-ana': { sub: 'g-ana', email: 'ana@example.com', name: 'Ana', email_verified: true },
    'good-bo': { sub: 'g-bo', email: 'bo@example.com', name: 'Bo', email_verified: true }
  };
  api._test.setGoogleVerifier(async (c) => {
    return people[c] || null;
  });

  const call = (method, route, { body, auth, headers } = {}) => new Promise((resolve) => {
    const req = { method, url: '/api/index?route=' + encodeURIComponent(route), headers: { ...(headers || {}) }, body };
    if (auth) req.headers.authorization = 'Bearer ' + auth;
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, data: JSON.parse(s) }); } };
    api(req, res);
  });
  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  ok', label); };

  // config + sign-in
  let r = await call('GET', 'config');
  ok(r.status === 200 && r.data.googleClientId === process.env.GOOGLE_CLIENT_ID, 'config gives the Google client id');
  r = await call('POST', 'auth/google', { body: { credential: 'forged' } });
  ok(r.status === 401, 'a bad Google credential is refused');
  r = await call('POST', 'auth/google', { body: { credential: 'good-ana' } });
  ok(r.status === 200 && r.data.session && r.data.isNew === true, 'Ana signs in and gets a session');
  const ana = r.data.session;
  r = await call('POST', 'auth/google', { body: { credential: 'good-bo' } });
  const bo = r.data.session;
  r = await call('GET', 'me');
  ok(r.status === 401, 'no session -> 401');
  r = await call('GET', 'me', { auth: ana + 'x' });
  ok(r.status === 401, 'tampered session -> 401');
  r = await call('GET', 'me', { auth: ana });
  ok(r.status === 200 && r.data.email === 'ana@example.com' && r.data.hasCode === false && r.data.dailyLimit === 0, 'me works');

  // setup code + Shortcut log
  r = await call('GET', 'setup-code', { auth: ana });
  const code = r.data.code;
  ok(/^sp_/.test(code), 'setup code made');
  r = await call('GET', 'setup-code', { auth: ana });
  ok(r.data.code === code, 'same setup code shown again');
  r = await call('POST', 'log', { auth: 'sp_wrongwrongwrongwrongwrong', body: { merchant: 'X', amount: '5' } });
  ok(r.status === 401, 'wrong setup code refused');
  r = await call('POST', 'log', { auth: code, body: {} });
  ok(r.status === 400, 'empty Shortcut body refused');
  r = await call('POST', 'log', { auth: code, body: { Merchant: 'Tim Hortons', Amount: '12.40', Card: 'Visa', Category: 'Dining & Coffee' } });
  ok(r.status === 200 && r.data.ok && /\$12\.40 spent today/.test(r.data.message), 'tap purchase logged: ' + r.data.message);
  r = await call('POST', 'log', { auth: code, body: { source: 'wallet', title: 'Visa', subtitle: 'TIM HORTONS #1234', body: '$12.40' } });
  ok(r.status === 200 && /\$12\.40 spent today/.test(r.data.message), 'Wallet duplicate counted once: ' + r.data.message);
  r = await call('POST', 'log', { headers: { 'x-setup-code': code }, body: JSON.stringify({ merchant: 'Metro\nCategory: Hack', amount: 30 }) });
  ok(r.status === 200 && /\$42\.40/.test(r.data.message), 'code in header, text body, newline injection flattened');

  // purchases are private to each person
  r = await call('GET', 'purchases', { auth: ana });
  ok(r.data.length === 3 && r.data.every((i) => i.state === 'open'), 'Ana sees her 3 purchases');
  const metro = r.data.find((i) => /Metro/.test(i.body));
  ok(!/\nCategory: Hack/.test(metro.body) && /Merchant: Metro Category: Hack/.test(metro.body), 'injected line stayed inside the merchant');
  r = await call('GET', 'purchases', { auth: bo });
  ok(r.data.length === 0, 'Bo sees none of Ana\'s purchases');
  r = await call('PATCH', 'purchases/' + metro.number, { auth: bo, body: { state: 'closed' } });
  ok(r.status === 404, 'Bo cannot change Ana\'s purchase');
  r = await call('GET', 'purchases/' + metro.number, { auth: bo });
  ok(r.status === 404, 'Bo cannot read Ana\'s purchase');

  // limit + alerts
  r = await call('PUT', 'limit', { auth: ana, body: { dailyLimit: -3 } });
  ok(r.status === 400, 'negative limit refused');
  r = await call('PUT', 'limit', { auth: ana, body: { dailyLimit: 40 } });
  ok(r.data.dailyLimit === 40, 'limit saved');
  r = await call('POST', 'devices', { auth: ana, body: { subscription: { endpoint: 'https://evil.example.com/x', keys: { p256dh: 'a', auth: 'b' } } } });
  ok(r.status === 400, 'non-push device address refused');
  pushes.length = 0;
  r = await call('POST', 'devices', { auth: ana, body: { subscription: { endpoint: 'https://web.push.apple.com/ana1', keys: { p256dh: 'p', auth: 'a' } } } });
  ok(r.status === 200 && pushes.length === 1 && pushes[0].title === 'Spending alerts are on', 'device saved and welcomed');
  await call('POST', 'devices', { auth: ana, body: { subscription: { endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: 'p', auth: 'a' } } } });
  pushes.length = 0;
  r = await call('POST', 'purchases', { auth: ana, body: { title: 'Spending - $5.00', body: 'Date: ' + new Date().toISOString() + '\nMerchant: Uber Eats\nAmount: $5.00\nCard: Added by hand\nCategory: Dining & Coffee\nEntry: manual' } });
  ok(r.status === 200 && pushes.length === 1 && /over your daily limit/i.test(pushes[0].title), 'manual add over the limit alerts: ' + (pushes[0] && pushes[0].body));
  const devs = await pg.query('select endpoint from devices');
  ok(devs.rows.length === 1, 'dead device removed after a failed push');
  r = await call('PATCH', 'purchases/' + r.data.number, { auth: ana, body: { state: 'closed' } });
  ok(r.data.state === 'closed', 'delete (close) works');
  r = await call('GET', 'purchases', { auth: ana });
  ok(r.data.length === 3, 'closed purchase hidden');

  // timed notes
  r = await call('GET', 'cron');
  ok(r.status === 401, 'cron needs its secret');
  r = await call('GET', 'cron', { auth: 'cron-secret' });
  ok(r.status === 200 && r.data.users === 1, 'cron runs for people with alerts on (sent ' + r.data.sent + ' at this hour)');

  // admin import
  r = await call('POST', 'admin/import', { auth: 'nope', body: {} });
  ok(r.status === 401, 'import needs the admin secret');
  r = await call('POST', 'admin/import', { auth: 'admin-secret', body: { email: 'BO@example.com', issues: [{ title: 'Spending - $6.14', body: 'Date: 2026-11-08T21:47:08Z\nMerchant: Dollarama\nAmount: $6.14\nCard: Visa\nCategory: Shopping', created_at: new Date(Date.now() - 3600e3).toISOString() }], dailyLimit: 30 } });
  ok(r.data.added === 1, 'import into Bo');
  r = await call('GET', 'me', { auth: bo });
  ok(r.data.dailyLimit === 30, 'imported limit');

  // sign out everywhere + delete account
  r = await call('POST', 'signout-all', { auth: bo });
  r = await call('GET', 'me', { auth: bo });
  ok(r.status === 401, 'old session dead after sign out everywhere');
  r = await call('POST', 'auth/google', { body: { credential: 'good-bo' } });
  const bo2 = r.data.session;
  ok(r.data.isNew === true, 'Bo signs back in');
  r = await call('DELETE', 'account', { auth: bo2 });
  ok(r.data.ok, 'Bo deletes his account');
  const left = await pg.query("select (select count(*) from users where email = 'bo@example.com')::int as u, (select count(*) from purchases p join users u on u.id = p.user_id where u.email = 'bo@example.com')::int as p");
  ok(left.rows[0].u === 0 && left.rows[0].p === 0, 'all of Bo\'s data is gone');
  r = await call('GET', 'nope');
  ok(r.status === 404, 'unknown route 404');

  console.log('\nALL PASSED:', pass);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
