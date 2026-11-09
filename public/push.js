/* Alerts: lets this phone receive push notifications from the server. Turning alerts on subscribes the phone and
   saves that subscription on the server, which then sends the morning note, over-limit alerts and the 9 PM summary. */
(function () {
  const KEY_DEVICE = 'spend.device';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clear = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };

  const ua = navigator.userAgent || '';
  const onIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const capable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // The page's service worker can take a moment to be ready, or never be. Do not wait forever.
  const ready = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no worker')), 4000))]);

  const bytes = (b64url) => {
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    const raw = atob((b64url + pad).split('-').join('+').split('_').join('/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  // Fetched ahead of time so the tap goes straight to the iPhone permission prompt with nothing in between.
  let keyCache = '';
  const preload = () => {
    if (keyCache || !window.spendSession.get()) return;
    window.spendApi('GET', 'config').then((c) => { keyCache = (c && c.vapidPublicKey) || ''; }).catch(() => {});
  };

  let message = '';
  let busy = false;
  const idle = 'A note each morning with what you can spend, an alert right after a purchase that puts you over your daily limit, and a reminder each night at 9.';

  const render = async () => {
    const text = $('#alerts-text');
    const on = $('#alerts-on');
    const off = $('#alerts-off');
    const note = $('#alerts-note');
    if (!text || !on || !off) return;
    on.hidden = true;
    off.hidden = true;
    note.hidden = !message;
    note.textContent = message;
    if (!capable() || (onIOS && !installed())) {
      text.textContent = 'Alerts need this app on your Home Screen. In Safari tap Share, then Add to Home Screen, and open it from the new icon.';
      return;
    }
    if (Notification.permission === 'denied') {
      text.textContent = 'Notifications are blocked for this app. Open Settings, then Notifications, then Spending, switch them on, and come back here.';
      return;
    }
    let sub = null;
    try {
      const reg = await ready();
      sub = await reg.pushManager.getSubscription();
    } catch (e) { /* no worker yet */ }
    if (read(KEY_DEVICE) && sub && Notification.permission === 'granted') {
      text.textContent = 'Alerts are on. ' + idle;
      off.hidden = false;
    } else {
      preload();
      text.textContent = idle;
      on.hidden = false;
    }
    on.disabled = busy;
    off.disabled = busy;
  };

  const register = async (sub) => {
    await window.spendApi('POST', 'devices', { subscription: sub.toJSON() });
    write(KEY_DEVICE, sub.endpoint);
  };

  const turnOn = async () => {
    if (busy) return;
    message = '';
    busy = true;
    const on = $('#alerts-on');
    on.textContent = 'Turning on…';
    try {
      // The permission prompt has to come straight from the tap, before any waiting.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        message = perm === 'denied' ? '' : 'Alerts stay off until you allow notifications.';
        return;
      }
      if (!keyCache) keyCache = ((await window.spendApi('GET', 'config')) || {}).vapidPublicKey || '';
      if (!keyCache) {
        message = 'Alerts are not set up on the server yet. Try again later.';
        return;
      }
      const reg = await ready();
      let sub = await reg.pushManager.getSubscription();
      const want = bytes(keyCache);
      if (sub && sub.options && sub.options.applicationServerKey) {
        const have = new Uint8Array(sub.options.applicationServerKey);
        if (have.length !== want.length || have.some((b, i) => b !== want[i])) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      await register(sub);
    } catch (e) {
      message = e && e.status === 401 ? 'Your sign-in has run out. Close the app, open it again and sign in.' : e && e.status ? e.message : 'Could not turn alerts on. Check your connection and try again.';
    } finally {
      busy = false;
      on.textContent = 'Turn on alerts';
      render();
    }
  };

  const turnOff = async () => {
    if (busy) return;
    message = '';
    busy = true;
    try {
      const reg = await ready();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try { await window.spendApi('DELETE', 'devices', { endpoint: sub.endpoint }); } catch (e) { /* the server drops dead phones on its own */ }
        await sub.unsubscribe();
      }
      clear(KEY_DEVICE);
    } catch (e) {
      message = 'Could not turn alerts off. Try again.';
    } finally {
      busy = false;
      render();
    }
  };

  // If the phone gave this app a new subscription since it was saved, save the new one.
  const resync = async () => {
    if (!window.spendSession.get() || !capable() || Notification.permission !== 'granted' || !read(KEY_DEVICE)) return;
    try {
      const reg = await ready();
      const sub = await reg.pushManager.getSubscription();
      if (sub && sub.endpoint !== read(KEY_DEVICE)) await register(sub);
    } catch (e) { /* try again next time the app opens */ }
  };

  const on = $('#alerts-on');
  const off = $('#alerts-off');
  if (on) on.addEventListener('click', turnOn);
  if (off) off.addEventListener('click', turnOff);
  if ('serviceWorker' in navigator) {
    // Tapping an alert while the app is open asks it to load the newest purchases.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data === 'refresh' && window.spendSession.get() && window.dash) window.dash.reload();
    });
  }
  window.spendAlertsRender = render;
  render();
  resync();
})();
