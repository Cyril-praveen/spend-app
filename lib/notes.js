'use strict';
// What the notifications say. Same rules as before: alert when today goes over (or close to) the daily limit,
// or the 14-day daily average when no limit is set; a morning note; an evening summary.
const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const money = (v) => cad.format(v);
const round2 = (v) => Math.round(v * 100) / 100;

const targetOf = (n, limit) => (limit > 0 ? { value: limit, word: 'daily limit' } : { value: n.kpi.per_day, word: 'daily average' });

const dayTotal = (n, day, upToTs) => round2(n.spend
  .filter((r) => r.period === 'now' && r.day === day && r.amount > 0 && (upToTs === undefined || r.ts <= upToTs))
  .reduce((s, r) => s + r.amount, 0));

// After a purchase arrives. Returns null when there is nothing worth saying.
const alertFor = (n, purchaseId, limit) => {
  const t = targetOf(n, limit);
  const avg = t.value;
  if (!(avg > 0)) return null;
  const mine = String(purchaseId);
  const row = n.spend.find((r) => r.period === 'now' && (r.id === mine || (r.dupIds || []).includes(mine)));
  if (!row || !(row.amount > 0)) return null;
  // The tap and Wallet entries for one payment arrive a few seconds apart. Only the first one alerts.
  const group = [row.id, ...(row.dupIds || [])].map(Number).filter((x) => !isNaN(x));
  if (group.some((x) => x < Number(purchaseId))) return null;
  if (row.day !== n.today) return null;
  const total = dayTotal(n, n.today, row.ts);
  const before = round2(total - row.amount);
  const latest = 'Latest: ' + row.merchant + ' ' + money(row.amount) + '.';
  if (total > avg) {
    return {
      title: before > avg ? 'Still over your ' + t.word : 'Over your ' + t.word,
      body: 'You have spent ' + money(total) + ' today, ' + money(round2(total - avg)) + ' over your ' + money(avg) + ' ' + t.word + '. ' + latest
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

// A one-line answer for the Shortcut to show right after it logs a purchase.
const quickLine = (n, limit) => {
  const t = targetOf(n, limit);
  const total = dayTotal(n, n.today);
  if (!(t.value > 0)) return 'Logged. ' + money(total) + ' spent today.';
  const left = round2(t.value - total);
  return left >= 0
    ? 'Logged. ' + money(total) + ' spent today, ' + money(left) + ' left.'
    : 'Logged. ' + money(total) + ' spent today, ' + money(-left) + ' over your ' + t.word + '.';
};

const eveningFor = (n, limit) => {
  const t = targetOf(n, limit);
  const avg = t.value;
  const rows = n.spend.filter((r) => r.period === 'now' && r.day === n.today && r.amount > 0);
  if (!rows.length) {
    return { title: 'No spending logged today', body: 'Nothing came through today. Open the app to check, or add a payment by hand.' + (avg > 0 ? ' Your ' + t.word + ' is ' + money(avg) + '.' : '') };
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
    title: 'You spent ' + money(total) + ' today',
    body: rows.length + (rows.length === 1 ? ' purchase.' : ' purchases.') + vs + ' Biggest: ' + biggest.merchant + ' ' + money(biggest.amount) + '. Most went to ' + top[0] + '. Tap to check the app.'
  };
};

const morningFor = (n, limit) => {
  const t = targetOf(n, limit);
  if (!(t.value > 0)) return { title: 'Good morning', body: 'Open the app to see how your spending is going.' };
  const left = round2(Math.max(0, t.value - dayTotal(n, n.today)));
  const ySum = dayTotal(n, n.yesterday);
  let was = ' Nothing was logged yesterday.';
  if (ySum > 0) {
    const d = round2(ySum - t.value);
    was = ' Yesterday: ' + money(ySum) + ', ' + money(Math.abs(d)) + (d > 0 ? ' over.' : ' under.');
  }
  return { title: 'You can spend ' + money(left) + ' today', body: 'That is your ' + t.word + '. Stay under it and you are on track.' + was };
};

module.exports = { alertFor, quickLine, eveningFor, morningFor, money };
