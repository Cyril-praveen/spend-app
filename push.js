/* Alerts: lets this phone receive push notifications from the spending job in the private data repo.
   Turning alerts on subscribes the phone to push and saves that subscription as a closed issue labelled push-device;
   the job reads those to know where to send alerts. */
(function () {
  const KEY_TOKEN = 'spend.token';
  const KEY_REPO = 'spend.repo';
  const KEY_DEVICE = 'spend.device';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clear = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };
  const device = () => { try { return JSON.parse(read(KEY_DEVICE) || 'null'); } catch (e) { return null; } };

  const ua = navigator.userAgent || '';
  const onIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const capable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const headers = (token) => ({
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  });
  const gh = (method, p, body) => {
    const repo = read(KEY_REPO);
    return fetch('https://api.github.com/repos/' + repo + p, { method, headers: headers(read(KEY_TOKEN)), body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  };

  // The page's service worker can take a moment to be ready, or never be (if it could not register). Do not wait forever.
  const ready = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no worker')), 4000))]);

  const bytes = (b64url) => {
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    const raw = atob((b64url + pad).split('-').join('+').split('_').join('/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  // The public half of the push key pair, made by the job the first time it runs.
  const publicKey = async () => {
    const res = await gh('GET', '/issues?state=all&labels=push-key&per_page=5&sort=created&direction=asc');
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const e = new Error('auth');
      e.kind = 'auth';
      throw e;
    }
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
    for (const i of await res.json()) {
      try {
        const k = JSON.parse(i.body);
        if (k && k.publicKey) return k.publicKey;
      } catch (e) { /* try the next one */ }
    }
    return '';
  };

  const registerDevice = async (sub) => {
    const make = await gh('POST', '/issues', { title: 'device: ' + (onIOS ? 'iPhone' : 'browser') + ' ' + new Date().toISOString().slice(0, 10), body: JSON.stringify(sub.toJSON()), labels: ['push-device'] });
    if (!make.ok) {
      const e = new Error('GitHub answered ' + make.status);
      e.status = make.status;
      throw e;
    }
    const issue = await make.json();
    await gh('PATCH', '/issues/' + issue.number, { state: 'closed' });
    write(KEY_DEVICE, JSON.stringify({ number: issue.number, endpoint: sub.endpoint }));
  };

  let message = '';
  let busy = false;
  // Fetched ahead of time so the tap goes straight to the iPhone permission prompt with nothing in between.
  let keyCache = '';
  const preload = () => { if (!keyCache && read(KEY_TOKEN)) publicKey().then((k) => { keyCache = k; }).catch(() => {}); };

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
    const idle = 'A note each morning with what you can spend, an alert right after a purchase that puts you over your daily limit, and a reminder each night at 9.';
    if (!capable() || (onIOS && !installed())) {
      text.textContent = 'Alerts need this app on your Home Screen. In Safari tap Share, then Add to Home Screen, and open it from the new icon.';
      return;
    }
    if (Notification.permission === 'denied') {
      text.textContent = 'Notifications are blocked for this app. Open Settings, then Notifications, then Spending, switch them on, and come back here.';
      return;
    }
    const mine = device();
    let sub = null;
    try {
      const reg = await ready();
      sub = await reg.pushManager.getSubscription();
    } catch (e) { /* no worker yet */ }
    if (!(mine && sub)) preload();
    if (mine && sub && Notification.permission === 'granted') {
      text.textContent = 'Alerts are on. ' + idle;
      off.hidden = false;
    } else {
      text.textContent = idle;
      on.hidden = false;
    }
    on.disabled = busy;
    off.disabled = busy;
  };

  const setBusy = (v, label) => {
    busy = v;
    const on = $('#alerts-on');
    if (on) on.textContent = v && label ? label : 'Turn on alerts';
  };

  const turnOn = async () => {
    if (busy) return;
    message = '';
    setBusy(true, 'Turning on…');
    try {
      // The permission prompt has to come straight from the tap, before any waiting.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        message = perm === 'denied' ? '' : 'Alerts stay off until you allow notifications.';
        return;
      }
      const key = keyCache || (await publicKey());
      keyCache = key;
      if (!key) {
        // First time on this repository: opening a "setup" issue starts the alert job, which makes the key.
        try {
          const made = await gh('POST', '/issues', { title: 'setup: alerts', body: 'Started from the app to get alerts ready.' });
          if (made.ok) {
            const i = await made.json();
            await gh('PATCH', '/issues/' + i.number, { state: 'closed' });
          }
        } catch (e) { /* the message below still applies */ }
        message = 'Getting alerts ready on GitHub for the first time. Wait a minute, then tap Turn on alerts again. If it still says this, add the alerts file (step 3 of the setup guide).';
        return;
      }
      const reg = await ready();
      let sub = await reg.pushManager.getSubscription();
      const want = bytes(key);
      if (sub && sub.options && sub.options.applicationServerKey) {
        const have = new Uint8Array(sub.options.applicationServerKey);
        if (have.length !== want.length || have.some((b, i) => b !== want[i])) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      await registerDevice(sub);
    } catch (e) {
      if (e && e.kind === 'auth') message = 'GitHub refused the token. Forget it below and enter it again.';
      else if (e && (e.status === 403 || e.status === 404 || e.status === 410)) message = 'The token needs Issues set to Read and write for the data repository.';
      else message = 'Could not turn alerts on. Check your connection and try again.';
    } finally {
      setBusy(false);
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
      if (sub) await sub.unsubscribe();
      const mine = device();
      if (mine && mine.number) {
        try { await gh('PATCH', '/issues/' + mine.number, { title: 'device-off: removed', body: '', state: 'closed' }); } catch (e) { /* the job drops dead devices on its own */ }
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
    if (!read(KEY_TOKEN) || !capable() || Notification.permission !== 'granted' || !device()) return;
    try {
      const reg = await ready();
      const sub = await reg.pushManager.getSubscription();
      if (sub && sub.endpoint !== device().endpoint) await registerDevice(sub);
    } catch (e) { /* try again next time the app opens */ }
  };

  const on = $('#alerts-on');
  const off = $('#alerts-off');
  if (on) on.addEventListener('click', turnOn);
  if (off) off.addEventListener('click', turnOff);
  if ('serviceWorker' in navigator) {
    // Tapping an alert while the app is open asks it to load the newest purchases.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data === 'refresh' && read(KEY_TOKEN) && window.dash) window.dash.reload();
    });
  }
  render();
  resync();
})();
