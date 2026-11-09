/* Talks to this app's own server. The sign-in session lives only on this phone. */
(function () {
  const KEY = 'spend.session';
  const read = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  window.spendSession = {
    get: read,
    set(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ } }
  };

  // Returns the parsed answer. Throws with .status (and .kind = 'auth' when the session is no longer valid).
  // A network failure throws the browser's own error, which callers treat as "offline".
  window.spendApi = async (method, path, body) => {
    const s = read();
    const headers = { Accept: 'application/json' };
    if (s) headers.Authorization = 'Bearer ' + s;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api/' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || 'The server answered ' + res.status);
      e.status = res.status;
      if (res.status === 401) e.kind = 'auth';
      throw e;
    }
    return data;
  };
})();
