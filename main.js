(function () {
  const KEY_TOKEN = 'spend.token';
  const KEY_REPO = 'spend.repo';
  const DEFAULT_REPO = 'Cyril-praveen/spend-data';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clear = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };

  const showSetup = (on, message) => {
    $('#setup').hidden = !on;
    $('#app').hidden = on;
    const err = $('#setup-error');
    err.hidden = !message;
    err.textContent = message || '';
    if (on) {
      $('#repo').value = read(KEY_REPO) || DEFAULT_REPO;
      $('#token').value = '';
    }
  };

  const start = () => {
    const token = read(KEY_TOKEN);
    const repo = read(KEY_REPO) || DEFAULT_REPO;
    if (!token) {
      dash.stop();
      showSetup(true);
      return;
    }
    showSetup(false);
    dash.start(() => window.loadPurchases(token, repo));
  };

  $('#save').addEventListener('click', async () => {
    const token = $('#token').value.trim();
    const repo = $('#repo').value.trim() || DEFAULT_REPO;
    if (!token) {
      showSetup(true, 'Paste the token first.');
      return;
    }
    const btn = $('#save');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await window.checkRepo(token, repo);
      write(KEY_TOKEN, token);
      write(KEY_REPO, repo);
      start();
    } catch (e) {
      const typed = $('#repo').value;
      showSetup(true, e && e.kind === 'auth'
        ? 'GitHub refused that. Check the repository name and that the token has Issues access to it.'
        : 'Could not reach GitHub. Check your connection and try again.');
      $('#repo').value = typed;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save and load';
    }
  });

  $('#forget').addEventListener('click', () => {
    clear(KEY_TOKEN);
    start();
  });

  const timeFmt = new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit' });
  dash.onData(() => {
    const m = dash.data('mail_now');
    const el = $('#updated');
    const err = $('#load-error');
    if (err) err.hidden = m.status !== 'error';
    if (!el) return;
    if (m.status === 'ok' && dash.lastUpdated) el.textContent = 'Updated ' + timeFmt.format(dash.lastUpdated);
    else if (m.status === 'loading') el.textContent = 'Loading…';
    else el.textContent = '';
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => dash.render(), 150);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => dash.render());

  setInterval(() => {
    if (document.visibilityState === 'visible' && read(KEY_TOKEN)) dash.reload();
  }, 3600000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !read(KEY_TOKEN)) return;
    if (!dash.lastUpdated || Date.now() - dash.lastUpdated.getTime() > 300000) dash.reload();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }

  start();
})();
