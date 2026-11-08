const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const money = (v) => (typeof v === 'number' && isFinite(v) ? cad.format(v) : '—');
const whole = (v) => (typeof v === 'number' ? d3.format(',')(v) : '—');
const share = (v) => (typeof v === 'number' ? (v > 0 && v < 0.005 ? '<1%' : d3.format('.0%')(v)) : '—');
const signed = (v) => (typeof v === 'number' ? (v > 0 ? '+' : v < 0 ? '−' : '') + d3.format(',.0%')(Math.abs(v)) : '—');
const axisMoney = (v) => '$' + (v >= 1000 ? d3.format('.3~s')(v) : d3.format(',.2~f')(v));
const when = d3.timeFormat('%b %-d, %-I:%M %p');
const dayLabel = d3.timeFormat('%b %-d');
const dayLong = d3.timeFormat('%a, %b %-d');
const dayKey = d3.timeFormat('%Y-%m-%d');
const parseDay = d3.timeParse('%Y-%m-%d');

const stateOf = (ids) => {
  let wait = false;
  for (const id of ids) {
    const s = dash.data(id).status;
    if (s === 'loading') wait = true;
    else if (s !== 'ok') return 'error';
  }
  return wait ? 'loading' : 'ok';
};
const rowsOf = (id) => dash.data(id).data || [];
const failLine = () => {
  const w = h('div', 'sp-fail');
  w.append(h('span', 'sp-dot'), h('span', 'sp-fail-text', 'Failed to load'));
  return w;
};
const failRow = (cols) => {
  const tr = h('tr');
  const td = h('td', 'sp-fail-cell');
  td.colSpan = cols;
  td.append(failLine());
  tr.append(td);
  return tr;
};

const txt = (name, field, fmt) => {
  dash.draw(name, (el) => {
    const st = stateOf(['kpi']);
    const row = st === 'ok' ? rowsOf('kpi')[0] : null;
    el.classList.toggle('dash-skeleton', st === 'loading');
    el.textContent = row ? fmt(row[field]) : '—';
  });
};
txt('t_top', 'top_category', (v) => v || '—');
txt('t_topamt', 'top_amount', money);
txt('t_topshare', 'top_share', share);
txt('t_total', 'cur_total', money);
txt('v_total', 'cur_total', money);
txt('v_perday', 'per_day', money);
txt('v_count', 'cur_count', whole);
txt('v_other', 'other_count', whole);
txt('v_prev', 'prev_total', money);

dash.draw('v_change', (el) => {
  const st = stateOf(['kpi']);
  const row = st === 'ok' ? rowsOf('kpi')[0] : null;
  const c = row ? row.change : null;
  el.classList.toggle('dash-skeleton', st === 'loading');
  el.classList.remove('sp-up', 'sp-down');
  el.textContent = signed(c);
  if (typeof c === 'number' && c !== 0) el.classList.add(c > 0 ? 'sp-up' : 'sp-down');
});

dash.draw('cats', (el) => {
  const st = stateOf(['by_cat']);
  el.replaceChildren();
  el.classList.toggle('dash-skeleton', st === 'loading');
  if (st === 'error') {
    el.append(failLine());
    return;
  }
  if (st !== 'ok') return;
  const rows = rowsOf('by_cat');
  const max = d3.max(rows, (r) => r.amount) || 1;
  rows.forEach((r, i) => {
    const row = h('div', 'sp-cat');
    row.append(h('span', 'sp-cat-name', r.category), h('span', 'sp-cat-amt', money(r.amount)));
    const track = h('div', 'sp-cat-track');
    const fill = h('div', 'sp-cat-fill');
    fill.style.width = Math.max(2, (r.amount / max) * 100) + '%';
    fill.style.background = i === 0 ? dash.colors[0] : 'var(--cds-chart-muted)';
    track.append(fill);
    const meta = h('div', 'sp-cat-meta');
    meta.append(h('span', '', share(r.share) + ' of spending'));
    if (typeof r.change === 'number') {
      const c = h('span', r.change > 0 ? 'sp-up' : r.change < 0 ? 'sp-down' : '', ' · ' + signed(r.change) + ' vs before');
      meta.append(c);
    } else {
      meta.append(h('span', '', ' · new this period'));
    }
    row.append(track, meta);
    el.append(row);
  });
});

dash.draw('days', (el) => {
  const st = stateOf(['by_day']);
  el.replaceChildren();
  el.classList.toggle('dash-skeleton', st === 'loading');
  if (st === 'error') {
    el.append(failLine());
    return;
  }
  if (st !== 'ok') return;
  const data = rowsOf('by_day');
  const byDay = new Map(data.map((r) => [r.day, r]));
  const today = d3.timeDay.floor(new Date());
  let first = d3.timeDay.offset(today, -14);
  let last = today;
  data.forEach((r) => {
    const d = parseDay(r.day);
    if (!d) return;
    if (d < first) first = d;
    if (d > last) last = d;
  });
  const days = d3.timeDay.range(first, d3.timeDay.offset(last, 1));
  const W = Math.max(el.clientWidth, 240);
  const H = 210;
  const top = 8;
  const bottom = 24;
  const right = 6;
  const amountOf = (d) => Math.max(0, (byDay.get(dayKey(d)) || {}).amount || 0);
  const y = d3.scaleLinear([0, d3.max(days, amountOf) || 1], [H - bottom, top]).nice(3);
  const ticks = y.ticks(3);
  const svg = d3.select(el).append('svg').attr('class', 'sp-axis').attr('width', '100%').attr('viewBox', '0 0 ' + W + ' ' + H).attr('role', 'img').attr('aria-label', 'Spending by day');
  const yl = svg.append('g').selectAll('text').data(ticks).join('text').attr('text-anchor', 'end').attr('dy', '0.32em').attr('y', (t) => y(t)).text(axisMoney);
  const left = Math.ceil(d3.max(yl.nodes(), (n) => n.getComputedTextLength()) || 0) + 10;
  yl.attr('x', left - 6);
  svg.append('g').selectAll('line').data(ticks).join('line').attr('x1', left).attr('x2', W - right).attr('y1', (t) => y(t)).attr('y2', (t) => y(t)).attr('stroke', t => (t === 0 ? 'var(--cds-chart-axis)' : 'var(--cds-chart-grid)'));
  const x = d3.scaleBand(days.map(dayKey), [left, W - right]).paddingInner(0.25).paddingOuter(0.1);
  const bw = Math.min(x.bandwidth(), 32);
  const off = (x.bandwidth() - bw) / 2;
  const bars = svg.append('g').selectAll('rect').data(days).join('rect')
    .attr('x', (d) => x(dayKey(d)) + off)
    .attr('width', bw)
    .attr('y', (d) => y(amountOf(d)))
    .attr('height', (d) => y(0) - y(amountOf(d)))
    .attr('rx', 3)
    .attr('fill', dash.colors[0]);
  const step = Math.max(1, Math.ceil(46 / x.step()));
  const xl = svg.append('g');
  days.forEach((d, i) => {
    if ((days.length - 1 - i) % step) return;
    const isLast = i === days.length - 1;
    xl.append('text')
      .attr('x', isLast ? x(dayKey(d)) + x.bandwidth() : x(dayKey(d)) + x.bandwidth() / 2)
      .attr('y', H - 8)
      .attr('text-anchor', isLast ? 'end' : 'middle')
      .text(dayLabel(d));
  });
  const tip = h('div', 'sp-tip');
  tip.hidden = true;
  el.append(tip);
  const show = (event, d) => {
    const rec = byDay.get(dayKey(d));
    tip.replaceChildren(h('div', 'sp-tip-day', dayLong(d)));
    tip.append(h('div', '', rec ? money(rec.amount) + ' · ' + rec.count + (rec.count === 1 ? ' purchase' : ' purchases') : 'No spending'));
    tip.hidden = false;
    const scale = el.clientWidth / W;
    const cx = (x(dayKey(d)) + x.bandwidth() / 2) * scale;
    tip.style.left = Math.max(0, Math.min(el.clientWidth - tip.offsetWidth, cx - tip.offsetWidth / 2)) + 'px';
    tip.style.top = Math.max(0, y(amountOf(d)) * scale - tip.offsetHeight - 6) + 'px';
    bars.attr('opacity', (b) => (b === d ? 1 : 0.45));
  };
  const hide = () => {
    tip.hidden = true;
    bars.attr('opacity', 1);
  };
  svg.append('g').selectAll('rect').data(days).join('rect')
    .attr('x', (d) => x(dayKey(d)) - x.step() * x.paddingInner() / 2)
    .attr('width', x.step())
    .attr('y', top)
    .attr('height', H - bottom - top)
    .attr('fill', 'transparent')
    .on('pointerenter', show)
    .on('pointermove', show)
    .on('pointerleave', hide);
});

dash.draw('merch_rows', (tb) => {
  const st = stateOf(['top_merchants']);
  tb.replaceChildren();
  if (st === 'error') {
    tb.append(failRow(3));
    return;
  }
  if (st !== 'ok') return;
  rowsOf('top_merchants').forEach((r) => {
    const tr = h('tr');
    tr.append(h('td', '', r.merchant), h('td', 'num', whole(r.count)), h('td', 'num', money(r.amount)));
    tb.append(tr);
  });
});

dash.draw('recent_rows', (tb) => {
  const st = stateOf(['recent']);
  tb.replaceChildren();
  if (st === 'error') {
    tb.append(failRow(4));
    return;
  }
  if (st !== 'ok') return;
  rowsOf('recent').forEach((r) => {
    const tr = h('tr');
    tr.dataset.key = r.id;
    tr.append(h('td', 'sp-when', r.ts ? when(new Date(r.ts)) : '—'), h('td', '', r.merchant), h('td', 'sp-hide-narrow', r.category), h('td', 'num', money(r.amount)));
    tb.append(tr);
  });
});

document.querySelectorAll('.sp-refresh').forEach((b) => {
  b.addEventListener('click', () => {
    dash.refresh('mail_now');
    dash.refresh('mail_prev');
  });
});

dash.onData(() => {
  const k = dash.data('kpi');
  const m = dash.data('mail_now');
  const p = dash.data('mail_prev');
  const row = k.status === 'ok' ? (k.data || [])[0] : null;
  const empty = !!row && row.cur_count === 0;
  const connect = m.status === 'connect' || m.status === 'declined' || p.status === 'connect' || p.status === 'declined';
  const busy = !!(m.refreshing || p.refreshing);
  document.querySelectorAll('.sp-js-connect').forEach((e) => { e.hidden = !connect; });
  document.querySelectorAll('.sp-js-empty').forEach((e) => { e.hidden = !empty; });
  document.querySelectorAll('.sp-js-full').forEach((e) => { e.hidden = empty; });
  document.querySelectorAll('.sp-js-take').forEach((e) => { e.hidden = !(row && row.cur_count > 0); });
  document.querySelectorAll('.sp-refresh').forEach((b) => { b.disabled = busy; });
});
