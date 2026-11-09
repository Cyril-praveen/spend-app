(function () {
  // Sign in with Google, connect the Shortcut, then show the spending. The session is kept only on this phone.
  // The iCloud link for the shared "Log purchase" Shortcut. Empty shows "ask for the link" instead.
  const SHORTCUT_URL = '';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clear = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };
  const session = window.spendSession;
  const onIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  const show = (which) => {
    ['#signin', '#onboard', '#app'].forEach((id) => { $(id).hidden = id !== which; });
    window.scrollTo(0, 0);
  };
  const note = (sel, text) => {
    const el = $(sel);
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
  };

  // Everything this app keeps on the phone for one person, removed on sign-out.
  const forgetPhone = () => ['spend.cache', 'spend.pending', 'spend.limit', 'spend.device', 'spend.email', 'spend.onboarded'].forEach(clear);

  // ---- sign-in ----------------------------------------------------------------------------------------------
  let config = null;
  const getConfig = async () => {
    if (!config) config = await window.spendApi('GET', 'config');
    return config;
  };
  let gisLoading = null;
  const loadGoogle = () => {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in')); };
        document.head.append(s);
      });
    }
    return gisLoading;
  };

  const onCredential = async (resp) => {
    note('#signin-error', '');
    try {
      const r = await window.spendApi('POST', 'auth/google', { credential: resp && resp.credential });
      session.set(r.session);
      write('spend.email', r.email || '');
      try { await window.spendApi('PUT', 'me', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); } catch (e) { /* stays on the default */ }
      // First time: connect the Shortcut. Coming back on a new phone: straight to the spending.
      if (r.isNew) showOnboard();
      else {
        write('spend.onboarded', '1');
        startApp();
      }
    } catch (e) {
      note('#signin-error', e && e.status ? e.message : 'Could not reach the server. Check your connection and try again.');
    }
  };

  const showSignIn = async (message) => {
    dash.stop();
    show('#signin');
    note('#signin-error', message || '');
    $('#install-tip').hidden = !(onIOS && !installed());
    try {
      const c = await getConfig();
      if (!c.googleClientId) {
        $('#google-btn').textContent = 'Sign-in is not ready yet. Try again later.';
        return;
      }
      await loadGoogle();
      window.google.accounts.id.initialize({ client_id: c.googleClientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true, ux_mode: 'popup' });
      $('#google-btn').replaceChildren();
      window.google.accounts.id.renderButton($('#google-btn'), {
        type: 'standard', theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
        size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: Math.min(320, $('#google-btn').clientWidth || 320)
      });
    } catch (e) {
      $('#google-btn').textContent = '';
      note('#signin-error', 'Could not load Google sign-in. Check your connection and reopen the app.');
    }
  };

  // ---- connecting the Shortcut ------------------------------------------------------------------------------
  let code = '';
  const showOnboard = async () => {
    dash.stop();
    show('#onboard');
    note('#onboard-error', '');
    $('#shortcut-link').hidden = !SHORTCUT_URL;
    $('#shortcut-missing').hidden = !!SHORTCUT_URL;
    if (SHORTCUT_URL) $('#shortcut-link').href = SHORTCUT_URL;
    $('#copy-code').disabled = true;
    $('#setup-code').textContent = 'Loading…';
    try {
      code = (await window.spendApi('GET', 'setup-code')).code;
      $('#setup-code').textContent = code;
      $('#copy-code').disabled = false;
    } catch (e) {
      if (e && e.kind === 'auth') return signOut('Please sign in again.');
      $('#setup-code').textContent = '—';
      note('#onboard-error', 'Could not load your setup code. Check your connection and try again.');
    }
  };
  $('#copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      $('#copy-code').textContent = 'Copied';
    } catch (e) {
      // Older browsers: select the code so it can be copied by hand.
      const r = document.createRange();
      r.selectNodeContents($('#setup-code'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      $('#copy-code').textContent = 'Selected, tap Copy';
    }
    setTimeout(() => { $('#copy-code').textContent = 'Copy setup code'; }, 2500);
  });
  $('#onboard-done').addEventListener('click', () => {
    write('spend.onboarded', '1');
    startApp();
  });

  // ---- the app ------------------------------------------------------------------------------------------------
  const startApp = () => {
    show('#app');
    $('#acct-email').textContent = read('spend.email') || 'your Google account';
    dash.start(() => window.loadPurchases());
    if (window.spendSyncLimit) window.spendSyncLimit();
    if (window.spendAlertsRender) window.spendAlertsRender();
  };

  const signOut = (message) => {
    session.clear();
    forgetPhone();
    window.spendLimit = 0;
    showSignIn(message);
  };

  $('#show-code').addEventListener('click', showOnboard);
  $('#sign-out').addEventListener('click', () => signOut('You are signed out.'));
  $('#sign-out-all').addEventListener('click', async () => {
    try {
      await window.spendApi('POST', 'signout-all');
      signOut('You are signed out on every phone.');
    } catch (e) {
      note('#acct-note', 'Could not reach the server. Try again.');
    }
  });
  let armed = false;
  $('#delete-account').addEventListener('click', async () => {
    const btn = $('#delete-account');
    if (!armed) {
      armed = true;
      btn.textContent = 'Tap again to delete everything';
      note('#acct-note', 'This deletes your account, every purchase, your limit and your alerts. It cannot be undone.');
      setTimeout(() => { armed = false; btn.textContent = 'Delete my account and all data'; }, 8000);
      return;
    }
    btn.disabled = true;
    try {
      await window.spendApi('DELETE', 'account');
      signOut('Your account and all its data are deleted.');
    } catch (e) {
      note('#acct-note', 'Could not delete right now. Check your connection and try again.');
    } finally {
      btn.disabled = false;
      armed = false;
      btn.textContent = 'Delete my account and all data';
    }
  });

  const timeFmt = new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit' });
  dash.onData(() => {
    const m = dash.data('mail_now');
    if (m.status === 'connect') {
      signOut('Please sign in again.');
      return;
    }
    const el = $('#updated');
    const err = $('#load-error');
    if (err) err.hidden = m.status !== 'error';
    if (!el) return;
    const offline = $('#offline-note');
    const stale = m.status === 'ok' && window.spendStale === true;
    if (offline) {
      offline.hidden = !stale;
      if (stale) offline.textContent = 'You\'re offline, or the server can\'t be reached. Showing what was saved on this phone (' + timeFmt.format(new Date(window.spendCachedAt)) + '). It updates when the connection is back.';
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

  const appShown = () => !$('#app').hidden && !!session.get();
  setInterval(() => {
    if (document.visibilityState === 'visible' && appShown()) dash.reload();
  }, 3600000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !appShown()) return;
    const unsent = window.spendQueue && window.spendQueue.list().length > 0;
    if (window.spendStale || unsent || !dash.lastUpdated || Date.now() - dash.lastUpdated.getTime() > 300000) dash.reload();
  });
  window.addEventListener('online', () => {
    if (appShown()) dash.reload();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }

  // Old GitHub-based copies of this app kept these; they are not used any more.
  ['spend.token', 'spend.repo'].forEach(clear);

  if (!session.get()) showSignIn();
  else if (!read('spend.onboarded')) showOnboard();
  else startApp();
})();
