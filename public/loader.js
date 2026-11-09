/* Reads purchases from this app's server. Each purchase has a title and a body of "Label: value" lines, the same
   format the Shortcut sends. The server also loads this file to work out alerts with the exact same rules. */
(function () {
  const unesc = (s) => String(s || '').split('&#39;').join("'").split('&quot;').join('"').split('&lt;').join('<').split('&gt;').join('>').split('&amp;').join('&');
  const flat = (s) => String(s || '').split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ');
  const fields = (t) => {
    const re = new RegExp('(^|[ ])(Source|Date|Merchant|Amount|Card|Category|Title|Subtitle|Body|Entry):', 'g');
    const hits = [];
    let m;
    while ((m = re.exec(t)) !== null) hits.push({ k: m[2], s: m.index + m[0].length, e: m.index });
    const out = {};
    hits.forEach((h, i) => {
      if (out[h.k] === undefined) out[h.k] = t.slice(h.s, i + 1 < hits.length ? hits[i + 1].e : t.length).trim();
    });
    return out;
  };

  const toRow = (issue) => {
    const f = fields(flat(unesc(issue.body)));
    return {
      id: String(issue.number),
      src: f.Source !== undefined ? 'wallet' : 'tap',
      subject: String(issue.title || ''),
      sent: issue.created_at || '',
      when: f.Date || '',
      merchant: f.Merchant || '',
      amount: f.Amount || '',
      card: f.Card || '',
      phoneCategory: f.Category || '',
      title: f.Title || '',
      subtitle: f.Subtitle || '',
      entry: (f.Entry || '').toLowerCase(),
      body: f.Body || ''
    };
  };

  // Splits purchases into the last 14 days and the 14 before, by when they arrived.
  const split = (issues, now) => {
    const day = 86400000;
    const out = { mail_now: [], mail_prev: [] };
    issues.forEach((i) => {
      const age = now - Date.parse(i.created_at);
      if (age <= 14 * day) out.mail_now.push(toRow(i));
      else if (age <= 28 * day) out.mail_prev.push(toRow(i));
    });
    return out;
  };
  window.spendRows = split;

  // A copy of the last good load and any payments added while offline live in this phone's storage.
  const CACHE_KEY = 'spend.cache';
  const PENDING_KEY = 'spend.pending';
  const jget = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      return v === null || v === undefined ? d : v;
    } catch (e) {
      return d;
    }
  };
  const jset = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or unavailable */ }
  };

  let flushing = null;
  const queue = {
    list: () => jget(PENDING_KEY, []),
    add(entry) {
      const item = { id: 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: entry.title, body: entry.body, created_at: new Date().toISOString() };
      jset(PENDING_KEY, queue.list().concat(item));
      return item;
    },
    // Sends saved payments one at a time, oldest first, and stops at the first one that fails.
    flush() {
      if (flushing) return flushing;
      flushing = (async () => {
        let sent = 0;
        for (const item of queue.list()) {
          try {
            await window.spendApi('POST', 'purchases', { title: item.title, body: item.body, created_at: item.created_at });
          } catch (e) {
            break;
          }
          jset(PENDING_KEY, queue.list().filter((x) => x.id !== item.id));
          sent++;
        }
        return sent;
      })().finally(() => { flushing = null; });
      return flushing;
    }
  };
  window.spendQueue = queue;

  window.spendStale = false;
  window.spendCachedAt = 0;
  window.loadPurchases = async () => {
    const now = Date.now();
    try { await queue.flush(); } catch (e) { /* anything unsent stays saved */ }
    let issues;
    try {
      issues = await window.spendApi('GET', 'purchases');
      jset(CACHE_KEY, { at: now, issues });
      window.spendStale = false;
    } catch (e) {
      const cached = jget(CACHE_KEY, null);
      if ((e && e.kind === 'auth') || (e && e.status >= 400 && e.status < 500) || !cached || !Array.isArray(cached.issues)) throw e;
      issues = cached.issues;
      window.spendStale = true;
      window.spendCachedAt = cached.at || 0;
    }
    const pending = queue.list().map((x) => ({ number: x.id, title: x.title, body: x.body, created_at: x.created_at }));
    return split(issues.concat(pending), now);
  };
})();
