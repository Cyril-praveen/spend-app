/* Reads purchases from the private GitHub repo: one issue per purchase, title like an email subject, body in the same "Label: value" lines. */
(function () {
  const unesc = (s) => String(s || '').split('&#39;').join("'").split('&quot;').join('"').split('&lt;').join('<').split('&gt;').join('>').split('&amp;').join('&');
  const flat = (s) => String(s || '').split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ');
  const fields = (t) => {
    const re = new RegExp('(^|[ ])(Source|Date|Merchant|Amount|Card|Category|Title|Subtitle|Body):', 'g');
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
      body: f.Body || ''
    };
  };

  window.checkRepo = async (token, repo) => {
    const res = await fetch('https://api.github.com/repos/' + repo + '/issues?state=all&per_page=1', { headers: headers(token) });
    check(res);
  };

  window.loadPurchases = async (token, repo) => {
    const day = 86400000;
    const now = Date.now();
    const since = new Date(now - 29 * day).toISOString();
    const issues = [];
    for (let page = 1; page <= 6; page++) {
      const url = 'https://api.github.com/repos/' + repo + '/issues?state=all&per_page=100&sort=created&direction=desc&since=' + encodeURIComponent(since) + '&page=' + page;
      const res = await fetch(url, { headers: headers(token), cache: 'no-store' });
      check(res);
      const items = await res.json();
      issues.push(...items.filter((i) => !i.pull_request));
      if (items.length < 100) break;
    }
    const out = { mail_now: [], mail_prev: [] };
    issues.forEach((i) => {
      const age = now - Date.parse(i.created_at);
      if (age <= 14 * day) out.mail_now.push(toRow(i));
      else if (age <= 28 * day) out.mail_prev.push(toRow(i));
    });
    return out;
  };
})();
