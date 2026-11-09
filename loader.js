/* Reads purchases from the private GitHub repo: one issue per purchase, title like an email subject, body in the same "Label: value" lines. */
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

  const headers = (token) => ({
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  });

  const check = (res) => {
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const e = new Error('GitHub refused the token or repository (' + res.status + ')');
      e.kind = 'auth';
      throw e;
    }
    if (!res.ok) throw new Error('GitHub answered ' + res.status);
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

  // Makes sure the token works and the repository is private, so purchases never end up public.
  window.checkRepo = async (token, repo) => {
    const info = await fetch('https://api.github.com/repos/' + repo, { headers: headers(token), cache: 'no-store' });
    check(info);
    const meta = await info.json();
    if (meta && meta.private === false) {
      const e = new Error('The repository is public');
      e.kind = 'public';
      throw e;
    }
    const res = await fetch('https://api.github.com/repos/' + repo + '/issues?state=all&per_page=1', { headers: headers(token), cache: 'no-store' });
    check(res);
  };

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

  let flushing = null;
  const queue = {
    list: () => jget(PENDING_KEY, []),
    add(entry) {
      const item = { id: 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: entry.title, body: entry.body, created_at: new Date().toISOString() };
      jset(PENDING_KEY, queue.list().concat(item));
      return item;
    },
    // Sends saved payments one at a time, oldest first, and stops at the first one that fails.
    flush(token, repo) {
      if (flushing) return flushing;
      flushing = (async () => {
        let sent = 0;
        for (const item of queue.list()) {
          let res;
          try {
            res = await fetch('https://api.github.com/repos/' + repo + '/issues', {
              method: 'POST',
              headers: { ...headers(token), 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: item.title, body: item.body })
            });
          } catch (e) {
            break;
          }
          if (!res.ok) break;
          jset(PENDING_KEY, queue.list().filter((x) => x.id !== item.id));
          sent++;
        }
        return sent;
      })().finally(() => { flushing = null; });
      return flushing;
    }
  };
  window.spendQueue = queue;

  // Issues the alert job keeps for itself (push keys, saved phones, the latest summary) are not purchases.
  const bookkeeping = (i) => (i.labels || []).some((l) => /^(push-key|push-device|summary|settings)$/.test(l && l.name)) || /^(push-key|device|device-off|summary|settings|setup):?/.test(String(i.title || ''));

  const fetchIssues = async (token, repo, now) => {
    const day = 86400000;
    const since = new Date(now - 29 * day).toISOString();
    const issues = [];
    for (let page = 1; page <= 6; page++) {
      const url = 'https://api.github.com/repos/' + repo + '/issues?state=open&per_page=100&sort=created&direction=desc&since=' + encodeURIComponent(since) + '&page=' + page;
      const res = await fetch(url, { headers: headers(token), cache: 'no-store' });
      check(res);
      const items = await res.json();
      issues.push(...items.filter((i) => !i.pull_request && !bookkeeping(i)));
      if (items.length < 100) break;
    }
    return issues;
  };

  window.spendStale = false;
  window.spendCachedAt = 0;
  window.loadPurchases = async (token, repo) => {
    const now = Date.now();
    try { await queue.flush(token, repo); } catch (e) { /* anything unsent stays saved */ }
    let issues;
    try {
      issues = await fetchIssues(token, repo, now);
      jset(CACHE_KEY, { at: now, issues: issues.map((i) => ({ number: i.number, title: i.title, body: i.body, created_at: i.created_at })) });
      window.spendStale = false;
    } catch (e) {
      const cached = jget(CACHE_KEY, null);
      if ((e && e.kind === 'auth') || !cached || !Array.isArray(cached.issues)) throw e;
      issues = cached.issues;
      window.spendStale = true;
      window.spendCachedAt = cached.at || 0;
    }
    const pending = queue.list().map((x) => ({ number: x.id, title: x.title, body: x.body, created_at: x.created_at }));
    return split(issues.concat(pending), now);
  };
})();
