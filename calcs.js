dash.calc('spend', {
  inputs: ['mail_now', 'mail_prev'],
  title: 'Purchases',
  description: 'Log emails turned into purchases: amount read, duplicates removed, category assigned.',
  fn: (mail_now, mail_prev) => {
    const CATS = ['Groceries', 'Dining & Coffee', 'Transport', 'Subscriptions & Software', 'Shopping', 'Entertainment', 'Health & Personal Care', 'Bills & Utilities', 'Travel'];
    const RULES = [
      ['Dining & Coffee', ['uber eats', 'ubereats', 'doordash', 'skipthedishes', 'skip the', 'tim hortons', 'tims', 'starbucks', 'mcdonald', 'subway', 'a&w', 'harvey', 'wendy', 'burger', 'pizza', 'restaurant', 'resto', 'caf', 'coffee', 'bakery', 'sushi', 'kfc', 'popeyes', 'chipotle', 'domino', 'second cup', 'boba', 'donut', 'bubble', 'grill', 'bistro', 'diner', 'pub ', 'kitchen', 'thai', 'ramen', 'shawarma', 'poutine', 'dairy queen', 'freshii', 'panera', 'taco', 'wings', 'biryani', 'chai', 'bbq', 'noodle']],
      ['Subscriptions & Software', ['netflix', 'spotify', 'apple.com/bill', 'apple services', 'icloud', 'youtube', 'disney', 'prime video', 'amazon prime', 'openai', 'chatgpt', 'anthropic', 'claude', 'github', 'adobe', 'microsoft', 'dropbox', 'notion', 'figma', 'canva', 'vercel', 'railway', 'crave', 'paramount', 'audible', 'google one', 'google play', 'patreon', 'substack', 'cursor', 'perplexity', 'linkedin']],
      ['Groceries', ['loblaw', 'no frills', 'nofrills', 'metro', 'sobeys', 'freshco', 'food basics', 'farm boy', 'iga ', 'zehrs', 'maxi', 'provigo', 'superstore', 'costco', 't&t', 'whole foods', 'grocery', 'supermarch', 'fruiterie', 'bulk barn', 'walmart supercentre', 'longos', 'adonis', 'marche']],
      ['Transport', ['uber', 'lyft', 'presto', 'ttc ', 'stm ', 'opus', 'oc transpo', 'petro', 'shell ', 'esso ', 'pioneer', 'ultramar', 'parking', 'impark', 'green p', 'go transit', 'taxi', 'bixi', 'bike share', 'circle k', 'enterprise', 'hertz', 'avis']],
      ['Travel', ['air canada', 'westjet', 'porter', 'airbnb', 'booking.com', 'expedia', 'hotel', 'via rail', 'flair', 'marriott', 'hilton', 'hostel', 'flixbus', 'greyhound', 'airport']],
      ['Health & Personal Care', ['shoppers', 'pharmacy', 'pharmaprix', 'jean coutu', 'rexall', 'london drugs', 'dental', 'clinic', 'physio', 'goodlife', 'gym', 'fitness', 'barber', 'salon', 'haircut', 'sephora', 'spa ']],
      ['Bills & Utilities', ['hydro', 'enbridge', 'bell ', 'rogers', 'telus', 'fido', 'koodo', 'virgin ', 'freedom ', 'insurance', 'rent ', 'internet', 'videotron', 'fizz', 'public mobile', 'chatr']],
      ['Entertainment', ['cineplex', 'cinema', 'steam', 'playstation', 'xbox', 'nintendo', 'ticketmaster', 'eventbrite', 'bowling', 'arcade', 'turf', 'topgolf', 'escape room', 'karaoke']],
      ['Shopping', ['amazon', 'amzn', 'dollarama', 'best buy', 'canadian tire', 'winners', 'marshalls', 'h&m', 'zara', 'uniqlo', 'ikea', 'apple store', 'nike', 'shein', 'etsy', 'ebay', 'walmart', 'home depot', 'rona ', 'gap ', 'staples', 'indigo', 'lululemon', 'aliexpress', 'temu']]
    ];
    const catOf = (merchant, phone) => {
      const m = ' ' + String(merchant || '').toLowerCase().replace(new RegExp('[^a-z0-9&./]+', 'g'), ' ').trim() + ' ';
      for (const [cat, words] of RULES) {
        if (words.some((w) => m.includes(' ' + w))) return { cat, how: 'merchant' };
      }
      const w = String(phone || '').toLowerCase().trim().split(new RegExp('[^a-z]+'))[0];
      if (w.length >= 4 && w !== 'other') {
        const hit = CATS.find((c) => c.toLowerCase().startsWith(w));
        if (hit) return { cat: hit, how: 'phone' };
      }
      return { cat: 'Other', how: 'none' };
    };
    const money = (s, strict) => {
      const t = String(s || '');
      const withSign = new RegExp('(-|−)?[ ]*(?:CA|C|US)?[$][ ]*([0-9][0-9,]*(?:[.][0-9]{1,2})?)').exec(t);
      if (withSign) {
        const v = Number(withSign[2].split(',').join(''));
        return withSign[1] ? -v : v;
      }
      const plain = new RegExp(strict ? '([0-9][0-9,]*[.][0-9]{2})' : '([0-9][0-9,]*(?:[.][0-9]{1,2})?)').exec(t);
      if (!plain) return null;
      const v = Number(plain[1].split(',').join(''));
      return new RegExp('^[ ]*(-|−)').test(t) ? -v : v;
    };
    const tsOf = (r) => {
      const dateOnly = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$').test(String(r.when || '').trim());
      if (!dateOnly) {
        const a = Date.parse(r.when);
        if (!isNaN(a)) return a;
      }
      const b = Date.parse(r.sent);
      return isNaN(b) ? 0 : b;
    };
    const dayOf = (r, ts) => {
      if (new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}').test(r.when || '')) return r.when.slice(0, 10);
      const d = new Date(ts);
      const p = (n) => (n < 10 ? '0' : '') + n;
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };
    const all = [...mail_now.map((r) => ({ ...r, period: 'now' })), ...mail_prev.map((r) => ({ ...r, period: 'prev' }))];
    const items = [];
    for (const r of all) {
      const wallet = r.src === 'wallet';
      let amount;
      let merchant;
      let card;
      if (wallet) {
        const text = [r.body, r.subtitle, r.title].join(' ');
        amount = money(r.body, true);
        if (amount === null) amount = money(r.subtitle, true);
        if (amount === null) amount = money(r.title, true);
        if (amount === null || new RegExp('declin', 'i').test(text)) continue;
        if (new RegExp('refund|return', 'i').test(text)) amount = -Math.abs(amount);
        merchant = r.subtitle || r.title;
        merchant = merchant.replace(new RegExp(',\\s*[^,]+,\\s*[A-Z]{2}$'), '');
        card = r.subtitle ? r.title : '';
      } else {
        amount = money(r.amount, false);
        if (amount === null) amount = money(r.subject, true);
        merchant = r.merchant;
        card = r.card;
      }
      if (!amount) continue;
      const ts = tsOf(r);
      items.push({ id: r.id, src: wallet ? 'wallet' : 'tap', period: r.period, ts, day: dayOf(r, ts), merchant: String(merchant || 'Unknown').trim() || 'Unknown', card: card || '', amount: Math.round(amount * 100) / 100, phone: r.phoneCategory });
    }
    items.sort((a, b) => (a.src === b.src ? 0 : a.src === 'tap' ? -1 : 1) || a.ts - b.ts);
    const norm = (s) => String(s).toLowerCase().split(new RegExp('[^a-z0-9]+')).join('').slice(0, 4);
    const kept = [];
    for (const it of items) {
      const dup = kept.some((k) => k.amount === it.amount && Math.abs(k.ts - it.ts) <= 600000 && (k.src !== it.src || norm(k.merchant) === norm(it.merchant)));
      if (!dup) kept.push(it);
    }
    return kept
      .map((it) => {
        const c = catOf(it.merchant, it.phone);
        return { id: it.id, src: it.src, period: it.period, ts: it.ts, day: it.day, merchant: it.merchant, card: it.card, amount: it.amount, category: c.cat, how: c.how };
      })
      .sort((a, b) => b.ts - a.ts);
  }
});

dash.calc('kpi', {
  inputs: ['spend'],
  title: 'Headline numbers',
  description: 'Totals for the last 14 days against the 14 days before.',
  fn: (spend) => {
    const cur = spend.filter((r) => r.period === 'now');
    const prev = spend.filter((r) => r.period === 'prev');
    const sum = (a) => Math.round(a.reduce((s, r) => s + r.amount, 0) * 100) / 100;
    const total = sum(cur);
    const before = sum(prev);
    const byCat = {};
    cur.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + r.amount; });
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    return [{
      cur_total: total,
      prev_total: before,
      change: before > 0 ? (total - before) / before : null,
      cur_count: cur.length,
      per_day: Math.round((total / 14) * 100) / 100,
      top_category: top ? top[0] : '',
      top_amount: top ? Math.round(top[1] * 100) / 100 : 0,
      top_share: top && total > 0 ? top[1] / total : null,
      other_count: cur.filter((r) => r.category === 'Other').length
    }];
  }
});

dash.calc('by_cat', {
  inputs: ['spend'],
  title: 'Spending by category',
  description: 'Last 14 days by category, with the change from the 14 days before.',
  fn: (spend) => {
    const now = {};
    const before = {};
    spend.forEach((r) => {
      const t = r.period === 'now' ? now : before;
      t[r.category] = (t[r.category] || 0) + r.amount;
    });
    const total = Object.values(now).filter((v) => v > 0).reduce((s, v) => s + v, 0);
    return Object.keys(now)
      .filter((c) => now[c] > 0)
      .map((c) => ({
        category: c,
        amount: Math.round(now[c] * 100) / 100,
        share: total > 0 ? now[c] / total : 0,
        prev_amount: Math.round((before[c] || 0) * 100) / 100,
        change: before[c] > 0 ? (now[c] - before[c]) / before[c] : null
      }))
      .sort((a, b) => b.amount - a.amount);
  }
});

dash.calc('by_day', {
  inputs: ['spend'],
  title: 'Spending by day',
  description: 'Last 14 days, total and number of purchases for each day with spending.',
  fn: (spend) => {
    const days = {};
    spend.filter((r) => r.period === 'now').forEach((r) => {
      const d = days[r.day] || { day: r.day, amount: 0, count: 0 };
      d.amount += r.amount;
      d.count += 1;
      days[r.day] = d;
    });
    return Object.values(days)
      .map((d) => ({ day: d.day, amount: Math.round(d.amount * 100) / 100, count: d.count }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
  }
});

dash.calc('top_merchants', {
  inputs: ['spend'],
  title: 'Top merchants',
  description: 'Merchants with the most spending in the last 14 days.',
  fn: (spend) => {
    const g = {};
    spend.filter((r) => r.period === 'now').forEach((r) => {
      const base = r.merchant.toLowerCase().split(new RegExp('#\\s*[0-9]+')).join(' ').trim();
      const key = base.split(new RegExp('[^a-z0-9]+')).join('');
      const m = g[key] || { merchant: r.merchant, amount: 0, count: 0 };
      m.amount += r.amount;
      m.count += 1;
      g[key] = m;
    });
    return Object.values(g)
      .map((m) => ({ merchant: m.merchant, amount: Math.round(m.amount * 100) / 100, count: m.count }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
  }
});

dash.calc('recent', {
  inputs: ['spend'],
  title: 'Recent purchases',
  description: 'The latest purchases from the last 14 days.',
  fn: (spend) => spend.filter((r) => r.period === 'now').slice(0, 12).map((r) => ({ id: r.id, merchant: r.merchant, category: r.category, amount: r.amount, ts: r.ts }))
});
