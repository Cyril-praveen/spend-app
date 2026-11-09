// Local copy of the whole app for browser tests: static files + the real server code on an in-memory Postgres.
// Google sign-in and phone push are faked. Run: node test/dev.js 8790
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  require('../lib/db').setTestDb(async (t, p) => (await pg.query(t, p)).rows);
  Object.assign(process.env, { SESSION_SECRET: 'dev-secret-'.repeat(4), GOOGLE_CLIENT_ID: 'dev-client', CRON_SECRET: 'dev-cron', ADMIN_SECRET: 'dev-admin', SITE_URL: 'https://localhost.test' });
  const w = require('web-push').generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = w.publicKey;
  process.env.VAPID_PRIVATE_KEY = w.privateKey;
  const api = require('../api/index.js');
  const people = { 'good-ana': { sub: 'g-ana', email: 'ana@example.com', name: 'Ana', email_verified: true }, 'good-bo': { sub: 'g-bo', email: 'bo@example.com', name: 'Bo', email_verified: true } };
  api._test.setGoogleVerifier(async (c) => people[c] || null);
  const pushes = [];
  api._test.setPushSender(async (sub, payload) => { pushes.push({ to: sub.endpoint, ...JSON.parse(payload) }); });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
  const root = path.join(__dirname, '..', 'public');
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__pushes') { res.end(JSON.stringify(pushes)); return; }
    if (u.pathname === '/__sql') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => { res.end(JSON.stringify((await pg.query(b)).rows)); }); return; }
    if (u.pathname.startsWith('/api/')) {
      req.url = '/api/index?route=' + encodeURIComponent(u.pathname.slice(5)) + (u.search ? '&' + u.search.slice(1) : '');
      return api(req, res);
    }
    let f = path.join(root, decodeURIComponent(u.pathname));
    if (!f.startsWith(root)) { res.statusCode = 403; res.end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  }).listen(Number(process.argv[2] || 8790), '127.0.0.1', () => console.log('dev server up'));
})();
