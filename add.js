(function () {
  // Add, edit and delete a payment. Each purchase is one GitHub issue in the private repo, the same as the Shortcuts write.
  // Deleting closes the issue, and the app ignores closed issues, so every change can be undone by reopening.
  const $ = (s) => document.querySelector(s);
  const KEY_TOKEN = 'spend.token';
  const KEY_REPO = 'spend.repo';
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const sheet = $('#add-sheet');
  const backdrop = $('#add-backdrop');
  const openBtn = $('#add-open');
  if (!sheet || !backdrop || !openBtn) return;
  const heading = $('#add-title');
  const sub = sheet.querySelector('.sub');
  const merchant = $('#add-merchant');
  const amount = $('#add-amount');
  const category = $('#add-category');
  const when = $('#add-when');
  const err = $('#add-error');
  const save = $('#add-save');
  const del = $('#add-delete');
  const toast = $('#toast');
  const toastText = $('#toast-text');
  const toastUndo = $('#toast-undo');
  let toastTimer = null;
  let undoOps = null;
  let editing = null;
  let armed = false;

  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const localInput = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  // 2026-11-08T16:47:00-05:00, so the app reads the exact local time.
  const isoWithOffset = (d) => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return localInput(d) + ':' + p2(d.getSeconds()) + sign + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  };
  const money = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);

  const showError = (text) => {
    err.textContent = text;
    err.hidden = !text;
  };
  const resetDelete = () => {
    armed = false;
    del.textContent = 'Delete payment';
  };

  const openSheet = (row) => {
    editing = row || null;
    hideToast();
    heading.textContent = editing ? 'Edit payment' : 'Add a payment';
    sub.textContent = editing ? 'Change anything that is wrong, then save.' : 'For an Apple Pay payment your phone didn\'t send.';
    merchant.value = editing ? editing.merchant : '';
    amount.value = editing ? String(editing.amount) : '';
    const known = editing && Array.from(category.options).some((o) => o.value === editing.category);
    category.value = known ? editing.category : '';
    when.value = localInput(editing && editing.ts ? new Date(editing.ts) : new Date());
    showError('');
    resetDelete();
    del.hidden = !editing;
    save.disabled = false;
    save.textContent = editing ? 'Save changes' : 'Add payment';
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
    if (!editing) setTimeout(() => merchant.focus(), 60);
  };
  const closeSheet = () => {
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('sheet-open');
    editing = null;
  };

  const api = (path, init) => fetch('https://api.github.com/repos/' + (read(KEY_REPO) || 'Cyril-praveen/spend-data') + path, {
    cache: 'no-store',
    ...init,
    headers: {
      Authorization: 'Bearer ' + read(KEY_TOKEN),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    }
  });
  const explain = (res) => {
    if (res.status === 401) return 'GitHub refused the saved token. Forget it in Settings and enter a new one.';
    if (res.status === 403 || res.status === 404 || res.status === 410) return 'This token can\'t change payments. In GitHub, set its Issues permission to Read and write.';
    return 'GitHub said no (' + res.status + '). Try again in a moment.';
  };
  const friendly = (x) => (x && x.message && !/Failed to fetch|Load failed|NetworkError/i.test(x.message) ? x.message : 'Could not reach GitHub. Check your connection and try again.');
  const patch = async (number, body) => {
    const res = await api('/issues/' + number, { method: 'PATCH', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(explain(res));
    return res;
  };

  const hideToast = () => {
    toast.hidden = true;
    clearTimeout(toastTimer);
  };
  const showToast = (text, ops) => {
    undoOps = ops && ops.length ? ops : null;
    toastText.textContent = text;
    toastUndo.hidden = !undoOps;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 9000);
  };

  openBtn.addEventListener('click', () => openSheet(null));
  window.spendEdit = (row) => {
    if (String(row.id).indexOf('p-') === 0) {
      showToast('Not sent yet. You can edit it once it has sent.', null);
      return;
    }
    openSheet(row);
  };
  backdrop.addEventListener('click', closeSheet);
  $('#add-cancel').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = merchant.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    const raw = amount.value.replace(/[$,\s]/g, '');
    const value = Number(raw);
    if (!name) return showError('Type where you paid.');
    if (!raw || !isFinite(value) || value === 0 || Math.abs(value) > 100000) return showError('Type the amount as a number, like 12.50. Use a minus sign for a refund.');
    const date = when.value ? new Date(when.value) : new Date();
    if (isNaN(date.getTime())) return showError('Pick a valid date and time.');
    const picked = category.value;
    const cents = Math.round(value * 100) / 100;
    const iso = isoWithOffset(date);
    const title = 'Spending - ' + money(cents) + ' - ' + iso.slice(0, 10) + ' - ' + (picked || 'Other');
    const lines = [
      'Date: ' + iso,
      'Merchant: ' + name,
      'Amount: ' + money(cents),
      'Card: ' + ((editing && editing.card) || 'Added by hand'),
      'Category: ' + (picked || 'Other')
    ];
    if (picked) lines.push('Entry: manual');
    const body = lines.join('\n');
    showError('');
    save.disabled = true;
    save.textContent = editing ? 'Saving…' : 'Adding…';
    try {
      if (editing) {
        const number = editing.id;
        const dups = editing.dupIds || [];
        const before = await api('/issues/' + number);
        if (!before.ok) throw new Error(explain(before));
        const old = await before.json();
        await patch(number, { title, body });
        for (const d of dups) await patch(d, { state: 'closed' });
        const ops = [{ n: number, body: { title: old.title, body: old.body || '' } }].concat(dups.map((d) => ({ n: d, body: { state: 'open' } })));
        closeSheet();
        showToast('Saved changes to ' + name, ops);
      } else {
        let res;
        try {
          res = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body }) });
        } catch (net) {
          // No connection: keep it on this phone and send it when the connection is back.
          if (!window.spendQueue) throw net;
          window.spendQueue.add({ title, body });
          closeSheet();
          showToast('Saved on this phone. It will send when you\'re back online.', null);
          if (window.dash) dash.reload();
          return;
        }
        if (!res.ok) throw new Error(explain(res));
        const made = await res.json();
        closeSheet();
        showToast('Added ' + money(cents) + ' at ' + name, made && made.number ? [{ n: made.number, body: { state: 'closed' } }] : null);
      }
      if (window.dash) dash.reload();
    } catch (x) {
      showError(friendly(x));
      save.disabled = false;
      save.textContent = editing ? 'Save changes' : 'Add payment';
    }
  });

  // Delete asks twice: the first tap arms it, the second does it.
  del.addEventListener('click', async () => {
    if (!editing) return;
    if (!armed) {
      armed = true;
      del.textContent = 'Tap again to delete';
      return;
    }
    const ids = [editing.id].concat(editing.dupIds || []);
    const name = editing.merchant;
    del.disabled = true;
    try {
      for (const n of ids) await patch(n, { state: 'closed' });
      closeSheet();
      showToast('Deleted ' + name, ids.map((n) => ({ n, body: { state: 'open' } })));
      if (window.dash) dash.reload();
    } catch (x) {
      showError(friendly(x));
      resetDelete();
    }
    del.disabled = false;
  });

  // Undo replays the saved opposite of the last change.
  toastUndo.addEventListener('click', async () => {
    const ops = undoOps;
    if (!ops) return;
    undoOps = null;
    toastUndo.hidden = true;
    toastText.textContent = 'Undoing…';
    try {
      for (const op of ops) await patch(op.n, op.body);
      showToast('Undone', null);
      if (window.dash) dash.reload();
    } catch (x) {
      showToast('Could not undo. Reopen the issue on GitHub.', null);
    }
  });
})();
