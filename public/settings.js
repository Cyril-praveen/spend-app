/* Daily limit. Set from the button at the top of the app and saved on the server, so the app and the alerts
   use the same one. A copy is kept on this phone so the chart can draw it straight away. */
(function () {
  const KEY_LIMIT = 'spend.limit';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
  const short = (v) => (Math.round(v) === v ? '$' + v : cad.format(v));

  const saved = Number(read(KEY_LIMIT));
  window.spendLimit = saved > 0 ? saved : 0;

  const sheet = $('#limit-sheet');
  const backdrop = $('#limit-backdrop');
  const openBtn = $('#limit-open');
  const pillText = $('#limit-pill-text');
  const input = $('#limit-input');
  const text = $('#limit-text');
  const note = $('#limit-note');
  const saveBtn = $('#limit-save');
  const clearBtn = $('#limit-clear');
  if (!sheet || !backdrop || !openBtn || !input) return;

  const average = () => {
    const d = window.dash && window.dash.data('kpi');
    const row = d && d.status === 'ok' && d.data && d.data[0];
    return row && row.per_day > 0 ? row.per_day : 0;
  };

  // The button at the top: "Daily limit" until one is set, then the amount, like "$30/day".
  const renderPill = () => {
    const v = window.spendLimit;
    // Set: a small "LIMIT" over the amount, so it stays narrow enough for the top bar. Not set: "Set limit".
    pillText.replaceChildren();
    if (v > 0) {
      const two = document.createElement('span');
      two.className = 'pill-two';
      const small = document.createElement('small');
      small.textContent = 'Limit a day';
      two.append(small, document.createTextNode(short(v)));
      pillText.append(two);
    } else {
      pillText.textContent = 'Set limit';
    }
    openBtn.classList.toggle('set', v > 0);
    openBtn.setAttribute('aria-label', v > 0 ? 'Daily limit ' + cad.format(v) + '. Change it' : 'Set a daily limit');
  };

  const showNote = (msg) => {
    note.hidden = !msg;
    note.textContent = msg || '';
  };

  const fillSheet = () => {
    const v = window.spendLimit;
    const avg = average();
    const avgText = avg > 0 ? ' Your 14-day average is ' + cad.format(avg) + ' a day.' : '';
    text.textContent = v > 0
      ? 'Your limit is ' + cad.format(v) + ' a day. The chart, alerts and morning note all use it.' + avgText
      : 'Pick how much you want to spend a day. The chart, alerts and morning note will use it.' + avgText;
    input.value = v > 0 ? String(v) : '';
    input.placeholder = avg > 0 ? String(Math.max(1, Math.floor(avg * 0.9))) : '30';
    clearBtn.hidden = !(v > 0);
    saveBtn.textContent = v > 0 ? 'Save new limit' : 'Save limit';
  };

  const open = () => {
    showNote('');
    fillSheet();
    const t = document.querySelector('#toast');
    if (t) t.hidden = true;
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
    setTimeout(() => input.focus(), 60);
  };
  const close = () => {
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('sheet-open');
  };

  const apply = (v) => {
    const changed = v !== window.spendLimit;
    window.spendLimit = v;
    write(KEY_LIMIT, String(v));
    renderPill();
    if (changed && window.dash) window.dash.render();
  };

  const sync = async () => {
    if (!window.spendSession.get()) return;
    try {
      const me = await window.spendApi('GET', 'me');
      apply(Number(me.dailyLimit) || 0);
    } catch (e) { /* keep the saved copy until the server can be reached */ }
  };

  let busy = false;
  const save = async (v) => {
    if (busy) return;
    busy = true;
    showNote('');
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    const label = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      await window.spendApi('PUT', 'limit', { dailyLimit: v });
      apply(v);
      close();
    } catch (e) {
      showNote(e && e.status === 401
        ? 'Your sign-in has run out. Close the app, open it again and sign in.'
        : e && e.status ? e.message : 'Could not save the limit. Check your connection and try again.');
    } finally {
      busy = false;
      saveBtn.disabled = false;
      clearBtn.disabled = false;
      if (saveBtn.textContent === 'Saving…') saveBtn.textContent = label;
    }
  };

  sheet.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Math.round(Number(input.value) * 100) / 100;
    if (!input.value.trim() || !(v >= 1) || v > 100000) {
      showNote('Type an amount between $1 and $100,000, like 30.');
      input.focus();
      return;
    }
    save(v);
  });
  clearBtn.addEventListener('click', () => save(0));
  $('#limit-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  openBtn.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) close();
  });

  // The "Set your own limit" link under the chart opens the same panel.
  window.spendOpenLimit = open;

  // Check the server for a limit set on another phone whenever purchases finish loading (at most once a minute).
  let lastSync = 0;
  if (window.dash) {
    window.dash.onData(() => {
      if (window.dash.data('mail_now').status !== 'ok' || Date.now() - lastSync < 60000) return;
      lastSync = Date.now();
      sync();
    });
  }
  // Called after signing in, so a new account never shows the last account's limit.
  window.spendSyncLimit = () => { lastSync = Date.now(); sync(); };
  renderPill();
})();
