(function () {
  // Drawing code for the spending app. The numbers come from calcs.js through the dash shim in runtime.js.
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
  const pct = (v) => (typeof v === 'number' ? d3.format(',.0%')(Math.abs(v)) : '—');
  const clock = d3.timeFormat('%-I:%M %p');
  const dayShort = d3.timeFormat('%b %-d');
  const dayLong = d3.timeFormat('%a, %b %-d');
  const dayKey = d3.timeFormat('%Y-%m-%d');
  const parseDay = d3.timeParse('%Y-%m-%d');

  // Icon and colour for each category. Anything unknown falls back to Other.
  const CAT = {
    'Dining & Coffee': ['☕', '#E8833A'],
    'Subscriptions & Software': ['💻', '#5B6CE0'],
    'Groceries': ['🛒', '#3BA776'],
    'Transport': ['🚌', '#3B82C4'],
    'Travel': ['✈️', '#14A3B8'],
    'Health & Personal Care': ['🩺', '#D9567A'],
    'Bills & Utilities': ['⚡', '#C9A227'],
    'Entertainment': ['🎬', '#C2528B'],
    'Shopping': ['🛍️', '#A855C7'],
    'Other': ['🧾', '#8C8C8C']
  };
  const catMeta = (c) => CAT[c] || CAT.Other;
  const MERCHANT_COLORS = ['#E8833A', '#5B6CE0', '#3BA776', '#3B82C4', '#14A3B8', '#D9567A', '#C9A227', '#C2528B', '#A855C7'];
  const colorFor = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return MERCHANT_COLORS[n % MERCHANT_COLORS.length];
  };

  const chip = (icon, color, cls) => {
    const c = h('span', 'chip' + (cls ? ' ' + cls : ''), icon);
    c.style.setProperty('--c', color);
    c.setAttribute('aria-hidden', 'true');
    return c;
  };

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
  const kpiRow = () => (stateOf(['kpi']) === 'ok' ? rowsOf('kpi')[0] : null);

  let activeCat = null;
  let showAll = false;
  const TX_LIMIT = 25;

  // Headline: total, change pill, per-day line.
  dash.draw('h_amt', (el) => {
    const st = stateOf(['kpi']);
    const row = kpiRow();
    el.classList.toggle('is-loading', st === 'loading');
    el.replaceChildren();
    const text = row ? money(row.cur_total) : '—';
    const dot = text.lastIndexOf('.');
    if (dot > 0) {
      el.append(document.createTextNode(text.slice(0, dot)), h('span', 'cents', text.slice(dot)));
    } else {
      el.append(document.createTextNode(text));
    }
  });

  dash.draw('h_sub', (el) => {
    const st = stateOf(['kpi']);
    const row = kpiRow();
    el.classList.toggle('is-loading', st === 'loading');
    el.textContent = row ? money(row.per_day) + ' a day · ' + whole(row.cur_count) + (row.cur_count === 1 ? ' purchase' : ' purchases') : '—';
  });

  dash.draw('h_pill', (el) => {
    const st = stateOf(['kpi']);
    const row = kpiRow();
    el.className = 'pill';
    el.replaceChildren();
    if (!row) {
      el.hidden = st !== 'loading';
      if (st === 'loading') el.classList.add('is-loading');
      return;
    }
    el.hidden = false;
    const c = row.change;
    if (typeof c !== 'number') {
      el.classList.add('flat');
      el.textContent = 'No earlier two weeks to compare';
      return;
    }
    if (c === 0) {
      el.classList.add('flat');
      el.textContent = 'Same as the two weeks before';
      return;
    }
    el.classList.add(c > 0 ? 'up' : 'down');
    el.append(h('span', 'arrow', c > 0 ? '▲' : '▼'), document.createTextNode(' ' + pct(c) + ' vs ' + money(row.prev_total) + ' before'));
  });

  // 14-day bar chart. Touch or hover a bar to read the day.
  dash.draw('days', (el) => {
    const st = stateOf(['by_day']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    const scrub = el.parentElement.querySelector('.scrub');
    const rest = 'Touch a bar to see a day';
    if (scrub) scrub.textContent = rest;
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
    const W = Math.max(el.clientWidth, 260);
    const H = 112;
    const top = 6;
    const bottom = 20;
    const amountOf = (d) => Math.max(0, (byDay.get(dayKey(d)) || {}).amount || 0);
    const y = d3.scaleLinear([0, d3.max(days, amountOf) || 1], [H - bottom, top]);
    const x = d3.scaleBand(days.map(dayKey), [0, W]).paddingInner(0.34).paddingOuter(0.05);
    const bw = Math.min(x.bandwidth(), 22);
    const off = (x.bandwidth() - bw) / 2;
    const svg = d3.select(el).append('svg').attr('class', 'bars-svg').attr('width', '100%').attr('viewBox', '0 0 ' + W + ' ' + H).attr('role', 'img').attr('aria-label', 'Spending for each of the last two weeks');
    const barH = (d) => (amountOf(d) > 0 ? Math.max(5, y(0) - y(amountOf(d))) : 4);
    const bars = svg.append('g').selectAll('rect').data(days).join('rect')
      .attr('class', (d) => (amountOf(d) > 0 ? 'bar' : 'bar zero'))
      .attr('x', (d) => x(dayKey(d)) + off)
      .attr('width', bw)
      .attr('y', (d) => y(0) - barH(d))
      .attr('height', barH)
      .attr('rx', Math.min(6, bw / 2));
    const axis = svg.append('g').attr('class', 'bars-axis');
    axis.append('text').attr('x', 2).attr('y', H - 4).attr('text-anchor', 'start').text(dayShort(days[0]));
    axis.append('text').attr('x', W - 2).attr('y', H - 4).attr('text-anchor', 'end').text('Today');
    const show = (event, d) => {
      const rec = byDay.get(dayKey(d));
      if (scrub) {
        scrub.textContent = dayLong(d) + ' · ' + (rec ? money(rec.amount) + ' · ' + rec.count + (rec.count === 1 ? ' purchase' : ' purchases') : 'no spending');
      }
      bars.classed('dim', (b) => b !== d);
    };
    const hide = () => {
      if (scrub) scrub.textContent = rest;
      bars.classed('dim', false);
    };
    svg.append('g').selectAll('rect').data(days).join('rect')
      .attr('x', (d) => x(dayKey(d)) - (x.step() - x.bandwidth()) / 2)
      .attr('width', x.step())
      .attr('y', 0)
      .attr('height', H - bottom)
      .attr('fill', 'transparent')
      .on('pointerenter', show)
      .on('pointermove', show)
      .on('pointerdown', show)
      .on('pointerleave', hide)
      .on('pointercancel', hide);
  });

  // Categories: a stacked bar, then one row per category. Tap a row to filter the purchases below.
  dash.draw('seg', (el) => {
    const st = stateOf(['by_cat']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st !== 'ok') return;
    rowsOf('by_cat').forEach((r) => {
      const s = h('span', 'seg-part');
      s.style.flexGrow = String(Math.max(r.share, 0.02));
      s.style.setProperty('--c', catMeta(r.category)[1]);
      s.title = r.category;
      s.classList.toggle('dim', !!activeCat && activeCat !== r.category);
      el.append(s);
    });
  });

  dash.draw('cats', (el) => {
    const st = stateOf(['by_cat']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    rowsOf('by_cat').forEach((r) => {
      const [icon, color] = catMeta(r.category);
      const row = h('button', 'cat' + (activeCat === r.category ? ' on' : ''));
      row.type = 'button';
      row.setAttribute('aria-pressed', activeCat === r.category ? 'true' : 'false');
      const mid = h('span', 'cat-mid');
      mid.append(h('span', 'cat-name', r.category));
      const sub = h('span', 'cat-sub');
      sub.append(document.createTextNode(share(r.share) + ' of spending'));
      if (typeof r.change === 'number' && r.change !== 0) {
        sub.append(document.createTextNode(' · '), h('span', r.change > 0 ? 'up-text' : 'down-text', (r.change > 0 ? '▲ ' : '▼ ') + pct(r.change)));
      } else if (typeof r.change !== 'number') {
        sub.append(document.createTextNode(' · new'));
      }
      mid.append(sub);
      row.append(chip(icon, color), mid, h('span', 'cat-amt', money(r.amount)));
      row.addEventListener('click', () => {
        activeCat = activeCat === r.category ? null : r.category;
        showAll = false;
        dash.render();
      });
      el.append(row);
    });
  });

  // Ways to cut back, worked out from the same numbers.
  dash.draw('tips', (el) => {
    const st = stateOf(['kpi', 'by_cat']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const k = rowsOf('kpi')[0];
    const cats = rowsOf('by_cat');
    if (!k || !cats.length) return;
    const tips = [];
    const top = cats[0];
    const save = Math.round(top.amount * 0.15 * 100) / 100;
    tips.push(['✂️', top.category + ' is ' + share(top.share) + ' of what you spent. Cutting it by 15% would save about ' + money(save) + ' every two weeks.']);
    const riser = cats
      .filter((c) => c.category !== top.category && typeof c.change === 'number' && c.change >= 0.25 && c.amount - c.prev_amount >= 5)
      .sort((a, b) => (b.amount - b.prev_amount) - (a.amount - a.prev_amount))[0];
    if (riser) tips.push(['📈', riser.category + ' is up ' + pct(riser.change) + ', ' + money(riser.amount - riser.prev_amount) + ' more than the two weeks before.']);
    if (k.cur_total > 0) tips.push(['🎯', 'A goal for the next two weeks: ' + money(Math.round(k.cur_total * 0.9 * 100) / 100) + ', which is 10% under this period.']);
    tips.forEach(([icon, text]) => {
      const row = h('div', 'tip');
      row.append(h('span', 'tip-icon', icon), h('p', 'tip-text', text));
      el.append(row);
    });
  });

  dash.draw('merch', (el) => {
    const st = stateOf(['top_merchants']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const rows = rowsOf('top_merchants');
    const max = d3.max(rows, (r) => r.amount) || 1;
    rows.forEach((r) => {
      const row = h('div', 'merch');
      const letter = (r.merchant.trim()[0] || '?').toUpperCase();
      const mid = h('span', 'cat-mid');
      mid.append(h('span', 'cat-name', r.merchant), h('span', 'cat-sub', r.count + (r.count === 1 ? ' purchase' : ' purchases')));
      const track = h('span', 'merch-track');
      const fill = h('span', 'merch-fill');
      fill.style.width = Math.max(4, (r.amount / max) * 100) + '%';
      fill.style.setProperty('--c', colorFor(r.merchant));
      track.append(fill);
      mid.append(track);
      row.append(chip(letter, colorFor(r.merchant), 'letter'), mid, h('span', 'cat-amt', money(r.amount)));
      el.append(row);
    });
  });

  // Purchases, grouped by day, newest first.
  dash.draw('tx', (el) => {
    const st = stateOf(['spend']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const all = rowsOf('spend').filter((r) => r.period === 'now');
    const rows = activeCat ? all.filter((r) => r.category === activeCat) : all;
    if (activeCat) {
      const bar = h('div', 'filter');
      bar.append(h('span', '', 'Showing ' + activeCat));
      const clear = h('button', 'link', 'Show all');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        activeCat = null;
        showAll = false;
        dash.render();
      });
      bar.append(clear);
      el.append(bar);
    }
    const shown = showAll ? rows : rows.slice(0, TX_LIMIT);
    const todayKey = dayKey(new Date());
    const yesterdayKey = dayKey(d3.timeDay.offset(d3.timeDay.floor(new Date()), -1));
    const label = (key) => (key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : parseDay(key) ? dayLong(parseDay(key)) : key);
    const groups = [];
    shown.forEach((r) => {
      const g = groups[groups.length - 1];
      if (g && g.day === r.day) g.rows.push(r);
      else groups.push({ day: r.day, rows: [r] });
    });
    groups.forEach((g) => {
      const total = rows.filter((r) => r.day === g.day).reduce((s, r) => s + r.amount, 0);
      const head = h('div', 'day-head');
      head.append(h('span', '', label(g.day)), h('span', 'day-total', money(Math.round(total * 100) / 100)));
      el.append(head);
      g.rows.forEach((r) => {
        const [icon, color] = catMeta(r.category);
        const row = h('div', 'tx');
        row.dataset.key = r.id;
        const mid = h('span', 'cat-mid');
        mid.append(h('span', 'cat-name', r.merchant), h('span', 'cat-sub', (r.ts ? clock(new Date(r.ts)) + ' · ' : '') + r.category));
        const amt = h('span', 'cat-amt' + (r.amount < 0 ? ' in' : ''), r.amount < 0 ? '+' + money(-r.amount) : money(r.amount));
        row.append(chip(icon, color), mid, amt);
        el.append(row);
      });
    });
    if (!rows.length) el.append(h('p', 'empty-line', 'Nothing here for the last two weeks.'));
    if (rows.length > TX_LIMIT && !showAll) {
      const more = h('button', 'more', 'Show all ' + rows.length + ' purchases');
      more.type = 'button';
      more.addEventListener('click', () => {
        showAll = true;
        dash.render();
      });
      el.append(more);
    }
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
    const busy = !!(m.refreshing || p.refreshing || m.status === 'loading');
    document.querySelectorAll('.sp-js-connect').forEach((e) => { e.hidden = !connect; });
    document.querySelectorAll('.sp-js-empty').forEach((e) => { e.hidden = !empty; });
    document.querySelectorAll('.sp-js-full').forEach((e) => { e.hidden = empty; });
    document.querySelectorAll('.sp-refresh').forEach((b) => {
      b.disabled = busy;
      b.classList.toggle('spin', busy);
    });
  });
})();
