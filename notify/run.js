#!/usr/bin/env node
/*
 * Spending alerts. Runs inside a GitHub Action in the private data repo (spend-data).
 *
 *   issues (a new purchase)  -> work out today's total against the daily limit (or, when none is set, the
 *                               14-day daily average) and, if it is over or close, push an alert to every phone.
 *   schedule (morning, 8 AM) -> push "you can spend $X today".
 *   schedule (evening, 9 PM) -> push the "check your spending" reminder with the day's total.
 *   workflow_dispatch        -> mode "summary" or "morning" sends that note now, "test" sends a test alert.
 *   push (workflow edited)   -> only makes sure the push keys exist.
 *
 * The numbers come from the same calcs.js and loader.js the app uses, so alerts always match the app:
 * duplicate tap + Wallet entries are merged, categories are the same, and the average is the same.
 *
 * Environment: GITHUB_REPOSITORY, GH_TOKEN, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, TZ (America/Toronto).
 * For testing: SPEND_FIXTURE=<issues.json> reads purchases from a file, DRY_RUN=1 prints instead of sending,
 * MODE=<issue|summary-scheduled|summary-now|test|bootstrap> overrides the event.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GH_TOKEN || '';
const FIXTURE = process.env.SPEND_FIXTURE || '';
const DRY = process.env.DRY_RUN === '1';
const APP_DIR = path.join(__dirname, '..');
const SITE = 'https://cyril-praveen.github.io/spend-app/';
const LABELS = { 'push-key': '5319e7', 'push-device': '0e8a16', summary: 'fbca04', settings: 'c5def5' };

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const money = (v) => cad.format(v);
const log = (...a) => console.log(...a);

// ---- GitHub -------------------------------------------------------------------------------------------------
const api = async (method, p, body) => {
  const res = await fetch('https://api.github.com/repos/' + REPO + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'spend-notify'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { ok: res.ok, status: res.status, json };
};

const ensureLabels = async () => {
  for (const [name, color] of Object.entries(LABELS)) {
    await api('POST', '/labels', { name, color }); // 422 when it already exists, which is fine
  }
};

const listByLabel = async (label, pages = 1) => {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const r = await api('GET', '/issues?state=all&labels=' + label + '&per_page=100&sort=created&direction=asc&page=' + page);
    if (!r.ok || !Array.isArray(r.json)) break;
    out.push(...r.json);
    if (r.json.length < 100) break;
  }
  return out;
};

// ---- Push keys and devices ----------------------------------------------------------------------------------
// The first run makes a key pair and keeps it in a closed issue in the private repo, so nothing has to be pasted by hand.
const getKeys = async (webpush) => {
  if (DRY) return webpush.generateVAPIDKeys();
  const read = async () => {
    for (const i of await listByLabel('push-key')) {
      try {
        const k = JSON.parse(i.body);
        if (k.publicKey && k.privateKey) return k;
      } catch (e) { /* skip */ }
    }
    return null;
  };
  let keys = await read();
  if (keys) return keys;
  const made = webpush.generateVAPIDKeys();
  const c = await api('POST', '/issues', { title: 'push-key', body: JSON.stringify(made), labels: ['push-key'] });
  if (c.ok) await api('PATCH', '/issues/' + c.json.number, { state: 'closed' });
  keys = await read(); // if two runs raced, everyone settles on the oldest key
  return keys || made;
};

const getDevices = async () => {
  if (DRY) return process.env.DEVICE_FILE ? JSON.parse(fs.readFileSync(process.env.DEVICE_FILE, 'utf8')) : [];
  const byEndpoint = new Map();
  for (const i of await listByLabel('push-device', 3)) {
    if (!/^device:/.test(i.title || '')) continue;
    try {
      const sub = JSON.parse(i.body);
      if (sub && sub.endpoint && sub.keys) byEndpoint.set(sub.endpoint, { number: i.number, sub });
    } catch (e) { /* skip */ }
  }
  return [...byEndpoint.values()];
};

// The daily limit the person set in the app, kept in a closed issue labelled settings. 0 means none is set.
const getLimit = async () => {
  if (DRY) return Number(process.env.LIMIT || 0) || 0;
  for (const i of await listByLabel('settings')) {
    if (!/^settings: limit/.test(i.title || '')) continue;
    try {
      const v = Number(JSON.parse(i.body).dailyLimit);
      return v > 0 ? v : 0;
    } catch (e) { /* try the next one */ }
  }
  return 0;
};

const send = async (webpush, devices, message) => {
  if (DRY) {
    log('[dry run] would send to ' + devices.length + ' device(s):', JSON.stringify(message));
    return 0;
  }
  let sent = 0;
  for (const d of devices) {
    try {
      await webpush.sendNotification(d.sub, JSON.stringify(message), { TTL: 6 * 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      log('push failed', e && e.statusCode, e && e.body ? String(e.body).slice(0, 120) : '');
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await api('PATCH', '/issues/' + d.number, { title: 'device-off: expired', body: '', state: 'closed' });
      }
    }
  }
  log('sent ' + sent + ' of ' + devices.length);
  return sent;
};

// ---- Numbers, from the app's own code -----------------------------------------------------------------------
const compute = async () => {
  const store = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } },
    document: { querySelectorAll: () => [] },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: FIXTURE ? async () => ({ ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) }) : fetch
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['runtime.js', 'calcs.js', 'loader.js']) {
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, f), 'utf8'), ctx, { filename: f });
  }
  await new Promise((resolve, reject) => {
    ctx.dash.start(async () => {
      try {
        const rows = await ctx.window.loadPurchases(TOKEN, REPO);
        setTimeout(resolve, 0);
        return rows;
      } catch (e) {
        reject(e);
        throw e;
      }
    });
  });
  await new Promise((r) => setTimeout(r, 0));
  const get = (id) => {
    const d = ctx.dash.data(id);
    if (d.status !== 'ok') throw new Error(id + ' is ' + d.status + ' ' + d.message);
    return d.data;
  };
  return { spend: get('spend'), kpi: get('kpi')[0], byDay: get('by_day') };
};

const todayKey = () => {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
const round2 = (v) => Math.round(v * 100) / 100;

// ---- Messages -----------------------------------------------------------------------------------------------
// What today is measured against: the limit if there is one, otherwise the 14-day daily average.
const targetOf = (n, limit) => (limit > 0 ? { value: limit, word: 'daily limit' } : { value: n.kpi.per_day, word: 'daily average' });

// Alert after a purchase. Returns null when there is nothing to say (still comfortably under the average).
const alertFor = (n, issue, limit) => {
  const t = targetOf(n, limit);
  const avg = t.value;
  if (!(avg > 0)) return null;
  const mine = String(issue.number);
  const row = n.spend.find((r) => r.period === 'now' && (r.id === mine || (r.dupIds || []).includes(mine)));
  if (!row || !(row.amount > 0)) return null;
  const group = [row.id, ...(row.dupIds || [])].map(Number).filter((x) => !isNaN(x));
  // The tap and Wallet entries for one payment arrive a few seconds apart. Only the first one alerts.
  if (group.some((x) => x < issue.number)) return null;
  const today = todayKey();
  if (row.day !== today) return null;
  // Total as it stood right after this purchase, so an alert that waited in a queue still reads correctly.
  const total = round2(n.spend.filter((r) => r.period === 'now' && r.day === today && r.amount > 0 && r.ts <= row.ts).reduce((s, r) => s + r.amount, 0));
  const before = round2(total - row.amount);
  const latest = 'Latest: ' + row.merchant + ' ' + money(row.amount) + '.';
  if (total > avg) {
    const over = money(round2(total - avg));
    const again = before > avg;
    return {
      title: again ? 'Still over your ' + t.word : 'Over your ' + t.word,
      body: 'You have spent ' + money(total) + ' today, ' + over + ' over your ' + money(avg) + ' ' + t.word + '. ' + latest
    };
  }
  if (total >= avg * 0.8 && before < avg * 0.8) {
    return {
      title: 'Close to your ' + t.word,
      body: money(total) + ' spent today. Only ' + money(round2(avg - total)) + ' left before you pass your ' + money(avg) + ' ' + t.word + '. ' + latest
    };
  }
  return null;
};

// The 9 PM reminder: the day's total and a nudge to open the app.
const summaryFor = (n, limit) => {
  const today = todayKey();
  const t = targetOf(n, limit);
  const avg = t.value;
  const rows = n.spend.filter((r) => r.period === 'now' && r.day === today && r.amount > 0);
  if (!rows.length) {
    return { day: today, title: 'No spending logged today', body: 'Nothing came through today. Open the app to check, or add a payment by hand.' + (avg > 0 ? ' Your ' + t.word + ' is ' + money(avg) + '.' : '') };
  }
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const biggest = rows.reduce((a, b) => (b.amount > a.amount ? b : a));
  const byCat = {};
  rows.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + r.amount; });
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  let vs = '';
  if (avg > 0) {
    const diff = round2(total - avg);
    vs = diff > 0 ? ' That is ' + money(diff) + ' over your ' + money(avg) + ' ' + t.word + '.' : ' That is ' + money(-diff) + ' under your ' + money(avg) + ' ' + t.word + '.';
  }
  return {
    day: today,
    title: 'You spent ' + money(total) + ' today',
    body: rows.length + (rows.length === 1 ? ' purchase.' : ' purchases.') + vs + ' Biggest: ' + biggest.merchant + ' ' + money(biggest.amount) + '. Most went to ' + top[0] + '. Tap to check the app.'
  };
};

// The 8 AM note: what is left to spend today, and how yesterday went.
const morningFor = (n, limit) => {
  const today = todayKey();
  const t = targetOf(n, limit);
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const p = (k) => (k < 10 ? '0' : '') + k;
  const yesterday = y.getFullYear() + '-' + p(y.getMonth() + 1) + '-' + p(y.getDate());
  const sum = (day) => round2(n.spend.filter((r) => r.period === 'now' && r.day === day && r.amount > 0).reduce((s, r) => s + r.amount, 0));
  if (!(t.value > 0)) return { day: today, title: 'Good morning', body: 'Open the app to see how your spending is going.' };
  const left = round2(Math.max(0, t.value - sum(today)));
  const ySum = sum(yesterday);
  let was = ' Nothing was logged yesterday.';
  if (ySum > 0) {
    const d = round2(ySum - t.value);
    was = ' Yesterday: ' + money(ySum) + ', ' + money(Math.abs(d)) + (d > 0 ? ' over.' : ' under.');
  }
  return { day: today, title: 'You can spend ' + money(left) + ' today', body: 'That is your ' + t.word + '. Stay under it and you are on track.' + was };
};

// ---- Main ---------------------------------------------------------------------------------------------------
(async () => {
  const webpush = require('web-push');
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const payload = process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  let mode = process.env.MODE || '';
  if (!mode) {
    if (eventName === 'issues') mode = 'issue';
    else if (eventName === 'schedule') mode = 'summary-scheduled';
    else if (eventName === 'workflow_dispatch') mode = { test: 'test', morning: 'morning-now' }[payload.inputs && payload.inputs.mode] || 'summary-now';
    else mode = 'bootstrap';
  }
  log('mode', mode);

  if (!DRY) await ensureLabels();
  const keys = await getKeys(webpush);
  webpush.setVapidDetails(SITE, keys.publicKey, keys.privateKey);
  const note = (m) => ({ ...m, url: SITE });

  if (mode === 'bootstrap') return;

  if (mode === 'test') {
    await send(webpush, await getDevices(), note({ title: 'Test alert', body: 'If you can read this, spending alerts are working.' }));
    return;
  }

  if (mode === 'issue') {
    const issue = payload.issue || {};
    const labels = (issue.labels || []).map((l) => l.name);
    // A phone just turned alerts on: say hello to that phone only.
    if (labels.includes('push-device') || /^device:/.test(issue.title || '')) {
      try {
        const sub = JSON.parse(issue.body);
        await send(webpush, [{ number: issue.number, sub }], note({ title: 'Spending alerts are on', body: 'You will get a note each morning with what you can spend, an alert when you go over your limit, and a reminder each night at 9.' }));
      } catch (e) { log('could not read the device entry'); }
      return;
    }
    if (labels.some((l) => l in LABELS) || /^(push-key|summary|device-off|settings|setup)/.test(issue.title || '')) return;
    const n = await compute();
    const msg = alertFor(n, issue, await getLimit());
    log(msg ? 'alert: ' + msg.title : 'no alert needed');
    if (msg) await send(webpush, await getDevices(), note(msg));
    return;
  }

  // The morning and evening notes. Cron runs at both UTC hours that can mean 8 AM / 9 PM in Toronto (it changes with daylight
  // saving), so the local hour decides which note this run is, and a saved "last sent" day stops a second copy.
  const daily = async (kind, scheduled) => {
    const title = kind === 'morning' ? 'summary: morning' : 'summary: latest';
    const state = DRY ? [] : await listByLabel('summary');
    const last = state.find((i) => (i.title || '').startsWith(title));
    let lastDay = '';
    try { lastDay = last ? JSON.parse(last.body).day : ''; } catch (e) { /* none */ }
    if (scheduled && lastDay === todayKey()) {
      log(kind + ' note already went out today');
      return;
    }
    const n = await compute();
    const limit = await getLimit();
    const s = kind === 'morning' ? morningFor(n, limit) : summaryFor(n, limit);
    await send(webpush, await getDevices(), note({ title: s.title, body: s.body }));
    if (DRY) return;
    // Keep the latest note where a Shortcut can read it too.
    const body = JSON.stringify({ day: s.day, title: s.title, body: s.body, at: new Date().toISOString() });
    if (last) {
      await api('PATCH', '/issues/' + last.number, { body });
    } else {
      const c = await api('POST', '/issues', { title, body, labels: ['summary'] });
      if (c.ok) await api('PATCH', '/issues/' + c.json.number, { state: 'closed' });
    }
  };

  if (mode === 'morning-now') return daily('morning', false);
  if (mode === 'summary-now') return daily('evening', false);
  const hour = new Date().getHours();
  const kind = hour >= 8 && hour <= 10 ? 'morning' : hour >= 21 && hour <= 23 ? 'evening' : '';
  if (!kind) {
    log('not morning or evening in Toronto (hour ' + hour + '), nothing to do');
    return;
  }
  return daily(kind, true);
})().catch((e) => {
  console.error('notifier failed:', e && e.message ? e.message : e);
  process.exit(1);
});
