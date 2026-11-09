(function () {
  const KEY_TOKEN = 'spend.token';
  const KEY_REPO = 'spend.repo';
  // Accepts "name/repo" or a pasted GitHub address like https://github.com/name/repo.
  const cleanRepo = (v) => {
    const t = String(v || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const parts = t.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : '';
  };
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
      let fromLink = '';
      try { fromLink = cleanRepo(new URLSearchParams(location.search).get('repo') || ''); } catch (e) { /* no link value */ }
      $('#repo').value = read(KEY_REPO) || fromLink;
      $('#token').value = '';
    }
  };

  const start = () => {
    const token = read(KEY_TOKEN);
    const repo = read(KEY_REPO);
    if (!token || !repo) {
      dash.stop();
      showSetup(true);
      return;
    }
    showSetup(false);
    dash.start(() => window.loadPurchases(token, repo));
  };

  $('#save').addEventListener('click', async () => {
    const token = $('#token').value.trim();
    const repo = cleanRepo($('#repo').value);
    const typedRepo = $('#repo').value;
    if (!repo) {
      showSetup(true, 'Type your repository as your-github-name/spend-data.');
      $('#repo').value = typedRepo;
      return;
    }
    if (!token) {
      showSetup(true, 'Paste the token first.');
      $('#repo').value = typedRepo;
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
      showSetup(true, e && e.kind === 'public'
        ? 'That repository is public, so anyone could see your purchases. In GitHub open the repository, then Settings, scroll to Danger Zone, and change visibility to Private. Then try again.'
        : e && e.kind === 'auth'
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
    clear('spend.cache');
    start();
  });

  const timeFmt = new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit' });
  dash.onData(() => {
    const m = dash.data('mail_now');
    const el = $('#updated');
    const err = $('#load-error');
    if (err) err.hidden = m.status !== 'error';
    if (!el) return;
    const note = $('#offline-note');
    const stale = m.status === 'ok' && window.spendStale === true;
    if (note) {
      note.hidden = !stale;
      if (stale) note.textContent = 'You\'re offline, or GitHub can\'t be reached. Showing what was saved on this phone (' + timeFmt.format(new Date(window.spendCachedAt)) + '). It updates when the connection is back.';
    }
    if (stale) el.textContent = 'Offline · saved ' + timeFmt.format(new Date(window.spendCachedAt));
    else if (m.status === 'ok' && dash.lastUpdated) el.textContent = 'Updated ' + timeFmt.format(dash.lastUpdated);
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
    const unsent = window.spendQueue && window.spendQueue.list().length > 0;
    if (window.spendStale || unsent || !dash.lastUpdated || Date.now() - dash.lastUpdated.getTime() > 300000) dash.reload();
  });

  window.addEventListener('online', () => {
    if (read(KEY_TOKEN)) dash.reload();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }

  start();
})();
