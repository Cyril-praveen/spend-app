/* A tiny stand-in for the dashboard runtime, so the same calculations and drawing code run in this app. */
(function () {
  const calcs = {};
  const draws = {};
  const listeners = [];
  const store = {};
  let loadFn = null;
  let version = 0;
  let scheduled = false;
  const blank = { status: 'missing', data: [], columns: [], message: '', refreshing: false, meta: [] };
  const palette = ['#4a7ab8', '#5f9d6e', '#b88a3e', '#8b6bb0', '#c0566b', '#5aa5a8', '#9a9a9a'];
  const accent = () => (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#c8643c';

  const setSources = (status, sources, message) => {
    ['mail_now', 'mail_prev'].forEach((id) => {
      const old = store[id];
      const data = sources ? sources[id] : status === 'refreshing' && old ? old.data : [];
      store[id] = { status: status === 'refreshing' ? 'ok' : status, data, columns: [], message: message || '', refreshing: status === 'refreshing', meta: [] };
    });
    Object.keys(calcs).forEach((id) => { delete store[id]; });
    let pending = Object.keys(calcs);
    let guard = 0;
    while (pending.length && guard++ < 20) {
      pending = pending.filter((id) => {
        const c = calcs[id];
        if (!c.inputs.every((x) => store[x])) return true;
        const inputs = c.inputs.map((x) => store[x]);
        const bad = inputs.find((s) => s.status !== 'ok');
        if (bad) {
          store[id] = { status: bad.status, data: [], columns: [], message: bad.message, refreshing: false, meta: [] };
        } else {
          try {
            store[id] = { status: 'ok', data: c.fn(...inputs.map((s) => s.data)), columns: [], message: '', refreshing: inputs.some((s) => s.refreshing), meta: [] };
          } catch (e) {
            store[id] = { status: 'error', data: [], columns: [], message: String((e && e.message) || e), refreshing: false, meta: [] };
          }
        }
        return false;
      });
    }
  };

  const render = () => {
    listeners.forEach((fn) => {
      try { fn(); } catch (e) { console.error(e); }
    });
    Object.keys(draws).forEach((name) => {
      document.querySelectorAll('[data-draw="' + name + '"]').forEach((el) => {
        try { draws[name](el); } catch (e) { console.error(name, e); }
      });
    });
  };

  const reload = async () => {
    if (!loadFn) return;
    const mine = ++version;
    if (store.mail_now && store.mail_now.status === 'ok') setSources('refreshing');
    else setSources('loading');
    render();
    try {
      const rows = await loadFn();
      if (mine !== version) return;
      dash.lastUpdated = new Date();
      setSources('ok', rows);
    } catch (e) {
      if (mine !== version) return;
      setSources(e && e.kind === 'auth' ? 'connect' : 'error', null, (e && e.message) || 'Could not load');
    }
    render();
  };

  const dash = {
    lastUpdated: null,
    get colors() { return [accent()].concat(palette); },
    loader() {},
    calc(id, o) { calcs[id] = o; },
    data(id) { return store[id] || blank; },
    draw(name, fn) { draws[name] = fn; },
    onData(fn) { listeners.push(fn); },
    refresh() {
      if (scheduled) return;
      scheduled = true;
      Promise.resolve().then(() => { scheduled = false; reload(); });
    },
    params() { return {}; },
    setParams() {},
    resetParams() {},
    setLink() {},
    start(fn) { loadFn = fn; reload(); },
    stop() { loadFn = null; version++; Object.keys(store).forEach((k) => { delete store[k]; }); },
    reload,
    render,
    // Works out every number from the given purchases right away, with no drawing. The server uses this for alerts.
    computeNow(rows) { setSources('ok', rows); }
  };
  window.dash = dash;
})();
