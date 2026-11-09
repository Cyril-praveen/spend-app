'use strict';
// Works out the app's numbers on the server with the app's own files (runtime.js, calcs.js, loader.js),
// so alerts always agree with what the app shows.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'public');
const FILES = ['runtime.js', 'calcs.js', 'loader.js'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

const fresh = () => {
  const ctx = {
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelectorAll: () => [] },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: () => Promise.reject(new Error('no network on the server'))
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const [name, code] of FILES) vm.runInContext(code, ctx, { filename: name });
  return ctx;
};

// Runs fn with the clock set to a time zone. Everything inside is synchronous, so no other request can see it.
const inZone = (tz, fn) => {
  const before = process.env.TZ;
  process.env.TZ = tz || 'America/Toronto';
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};

// issues: [{ number, title, body, created_at }] for the last 29 days. Returns the same numbers the app uses.
const numbers = (issues, tz, now) => inZone(tz, () => {
  const ctx = fresh();
  ctx.dash.computeNow(ctx.window.spendRows(issues, now || Date.now()));
  const get = (id) => {
    const d = ctx.dash.data(id);
    if (d.status !== 'ok') throw new Error(id + ' could not be worked out: ' + d.message);
    return JSON.parse(JSON.stringify(d.data));
  };
  const p = (n) => (n < 10 ? '0' : '') + n;
  const d = new Date(now || Date.now());
  const y = new Date(d.getTime());
  y.setDate(y.getDate() - 1);
  return {
    spend: get('spend'),
    kpi: get('kpi')[0],
    byDay: get('by_day'),
    today: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
    yesterday: y.getFullYear() + '-' + p(y.getMonth() + 1) + '-' + p(y.getDate()),
    hour: d.getHours()
  };
});

module.exports = { numbers, inZone };
