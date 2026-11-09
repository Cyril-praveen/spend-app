/* Daily limit. The number is kept in a closed issue labelled "settings" in the private data repo, so the app and the
   alert job both use the same one. A copy is kept on this phone so the chart can draw it straight away. */
(function () {
  const KEY_TOKEN = 'spend.token';
  const KEY_REPO = 'spend.repo';
  const KEY_LIMIT = 'spend.limit';
  const DEFAULT_REPO = 'Cyril-praveen/spend-data';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

  const saved = Number(read(KEY_LIMIT));
  window.spendLimit = saved > 0 ? saved : 0;

  const gh = (method, p, body) => fetch('https://api.github.com/repos/' + (read(KEY_REPO) || DEFAULT_REPO) + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + read(KEY_TOKEN),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });

  const fail = (res) => {
    const e = new Error('GitHub answered ' + res.status);
    e.status = res.status;
    throw e;
  };

  // The oldest settings issue is the one everyone uses, so two taps in a row cannot make two limits.
  const find = async () => {
    const res = await gh('GET', '/issues?state=all&labels=settings&per_page=5&sort=created&direction=asc');
    if (!res.ok) fail(res);
    for (const i of await res.json()) {
      if (!/^settings: limit/.test(i.title || '')) continue;
      try {
        const v = Number(JSON.parse(i.body).dailyLimit);
        return { number: i.number, value: v > 0 ? v : 0 };
      } catch (e) { /* try the next one */ }
    }
    return { number: 0, value: 0 };
  };

  let note = '';
  const render = () => {
    const text = $('#limit-text');
    const input = $('#limit-input');
    const clear = $('#limit-clear');
    const msg = $('#limit-note');
    if (!text || !input) return;
    const v = window.spendLimit;
    text.textContent = v > 0
      ? 'Your daily limit is ' + cad.format(v) + '. The chart, the alerts and the morning note all use it.'
      : 'Without a limit, the chart and alerts use your 14-day daily average.';
    if (document.activeElement !== input) input.value = v > 0 ? String(v) : '';
    clear.hidden = !(v > 0);
    msg.hidden = !note;
    msg.textContent = note;
  };

  const apply = (v) => {
    const changed = v !== window.spendLimit;
    window.spendLimit = v;
    write(KEY_LIMIT, String(v));
    if (changed && window.dash) window.dash.render();
    render();
  };

  const sync = async () => {
    if (!read(KEY_TOKEN)) return;
    try {
      const r = await find();
      apply(r.value);
    } catch (e) { /* keep the saved copy until GitHub can be reached */ }
  };

  const save = async (v) => {
    note = '';
    const saveBtn = $('#limit-save');
    const clearBtn = $('#limit-clear');
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    try {
      const body = JSON.stringify({ dailyLimit: v });
      const cur = await find();
      if (cur.number) {
        const res = await gh('PATCH', '/issues/' + cur.number, { body });
        if (!res.ok) fail(res);
      } else {
        const res = await gh('POST', '/issues', { title: 'settings: limit', body, labels: ['settings'] });
        if (!res.ok) fail(res);
        const made = await res.json();
        await gh('PATCH', '/issues/' + made.number, { state: 'closed' });
      }
      apply(v);
    } catch (e) {
      note = e && (e.status === 401 || e.status === 403 || e.status === 404)
        ? 'The token needs Issues set to Read and write for the data repository.'
        : 'Could not save the limit. Check your connection and try again.';
      render();
    } finally {
      saveBtn.disabled = false;
      clearBtn.disabled = false;
    }
  };

  const input = $('#limit-input');
  if (input) {
    $('#limit-save').addEventListener('click', () => {
      const v = Math.round(Number(input.value) * 100) / 100;
      if (!(v > 0) || v > 100000) {
        note = 'Enter an amount between $1 and $100,000.';
        render();
        return;
      }
      save(v);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#limit-save').click(); });
    $('#limit-clear').addEventListener('click', () => save(0));
  }

  // The "Set your own limit" link under the chart opens Settings with the field ready.
  window.spendOpenLimit = () => {
    const d = $('#settings-details');
    if (d) d.open = true;
    if (input) {
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => input.focus({ preventScroll: true }), 250);
    }
  };

  // Check GitHub for a limit set elsewhere whenever purchases finish loading (at most once a minute).
  let lastSync = 0;
  if (window.dash) {
    window.dash.onData(() => {
      if (window.dash.data('mail_now').status !== 'ok' || Date.now() - lastSync < 60000) return;
      lastSync = Date.now();
      sync();
    });
  }
  render();
})();
