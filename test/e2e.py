# Browser test of the whole new-user journey against test/dev.js. Run: python3 test/e2e.py
import json, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8790'
FAKE_GOOGLE = """
window.__who = window.__who || 'good-ana';
window.google = { accounts: { id: {
  initialize(o) { this.cb = o.callback; },
  renderButton(el) { const b = document.createElement('button'); b.id = 'fake-google'; b.textContent = 'Continue with Google'; b.onclick = () => this.cb({ credential: window.__who }); el.append(b); }
} } };
"""
PUSH_STUB = """
(() => {
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  window.PushManager = function () {};
  let perm = 'default';
  window.Notification = { get permission() { return perm; }, requestPermission: async () => { perm = 'granted'; return perm; } };
  let current = null;
  const reg = { pushManager: {
    getSubscription: async () => current,
    subscribe: async (o) => { current = { endpoint: 'https://web.push.apple.com/test-phone', options: { applicationServerKey: o.applicationServerKey.buffer }, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { current = null; return true; } }; return current; } } };
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), register: async () => reg, addEventListener() {} }, configurable: true });
})();
"""

def http(method, path, body=None, auth=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + auth} if auth else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'null')

passed = 0
def ok(cond, label):
    global passed
    assert cond, label
    passed += 1
    print('  ok', label)

P = sync_playwright().start()
b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True,
                    user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')
ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
pg = ctx.new_page(); errs = []
pg.on('pageerror', lambda e: errs.append(str(e)))
pg.add_init_script(FAKE_GOOGLE)
t = lambda s: pg.locator(s).inner_text().replace('\n', ' / ')
vis = lambda s: pg.locator(s).is_visible()

# 1. New friend opens the app in Safari
pg.goto(BASE + '/'); pg.wait_for_timeout(600)
ok(vis('#signin') and not vis('#app'), 'sign-in page first')
ok(vis('#install-tip'), 'iPhone in Safari gets the Add to Home Screen tip')
pg.screenshot(path='/tmp/e2e-signin.png')
pg.click('#fake-google'); pg.wait_for_timeout(800)
ok(vis('#onboard'), 'after sign-in a new person gets the Connect your iPhone page')
code = pg.inner_text('#setup-code')
ok(code.startswith('sp_'), 'setup code shown')
pg.click('#copy-code'); pg.wait_for_timeout(200)
ok(pg.evaluate('navigator.clipboard.readText()') == code, 'copy button copies the code')
ok(vis('#shortcut-missing'), 'no Shortcut link yet -> ask-for-link note')
pg.screenshot(path='/tmp/e2e-onboard.png', full_page=True)

# 2. The Shortcut sends purchases (tap + the Wallet alert for the same payment, then another)
s, r = http('POST', '/api/log', {'merchant': 'Tim Hortons', 'amount': '12.40', 'card': 'Visa', 'category': 'Dining & Coffee'}, auth=code)
ok(s == 200 and r['ok'] and '$12.40 spent today' in r['message'], 'Shortcut tap logged: ' + r['message'])
s, r = http('POST', '/api/log', {'source': 'wallet', 'title': 'Visa', 'subtitle': 'TIM HORTONS #1234', 'body': '$12.40'}, auth=code)
ok(s == 200, 'Shortcut Wallet alert logged: ' + r['message'])
http('POST', '/api/log', {'merchant': 'Adonis', 'amount': '$85.02', 'card': 'Amex'}, auth=code)
pg.click('#onboard-done'); pg.wait_for_timeout(900)
ok(vis('#app'), 'Done -> the spending app')
ok(t('[data-draw=h_amt]').replace(' ', '') in ('$97.42',), 'total counts the tap+Wallet pair once: ' + t('[data-draw=h_amt]'))
ok(pg.locator('#acct-email').text_content() == 'ana@example.com', 'account email shown in settings')
pg.screenshot(path='/tmp/e2e-app.png')

# 3. Daily limit from the top button
pg.click('#limit-open'); pg.fill('#limit-input', '50'); pg.click('#limit-save'); pg.wait_for_timeout(600)
ok('$50' in t('#limit-open'), 'limit set from the top button: ' + t('#limit-open'))
ok('over today' in t('.avg-note'), 'chart says over today: ' + t('.avg-note').split(' / ')[0])

# 4. Add, edit, delete, undo a payment by hand
pg.click('#add-open'); pg.fill('#add-merchant', 'Metro'); pg.fill('#add-amount', '10'); pg.click('#add-save'); pg.wait_for_timeout(800)
ok('Added $10.00 at Metro' in t('#toast-text'), 'manual add')
rows = lambda: [x.replace('\n', ' | ') for x in pg.locator('[data-draw=tx] .tx').all_inner_texts()]
ok(any('Metro' in x for x in rows()), 'Metro listed')
pg.locator('[data-draw=tx] .tx', has_text='Metro').first.click(); pg.wait_for_timeout(300)
pg.fill('#add-amount', '11.5'); pg.click('#add-save'); pg.wait_for_timeout(800)
ok(any('Metro' in x and '$11.50' in x for x in rows()), 'edit saved')
pg.click('#toast-undo'); pg.wait_for_timeout(900)
ok(any('Metro' in x and '$10.00' in x for x in rows()), 'undo edit')
pg.locator('[data-draw=tx] .tx', has_text='Metro').first.click(); pg.wait_for_timeout(300)
pg.click('#add-delete'); pg.click('#add-delete'); pg.wait_for_timeout(800)
ok(not any('Metro' in x for x in rows()), 'delete')
pg.click('#toast-undo'); pg.wait_for_timeout(900)
ok(any('Metro' in x for x in rows()), 'undo delete')

# 5. Alerts on (phone push faked)
pg2 = ctx.new_page(); pg2.on('pageerror', lambda e: errs.append(str(e)))
pg2.add_init_script(FAKE_GOOGLE); pg2.add_init_script(PUSH_STUB)
pg2.goto(BASE + '/'); pg2.wait_for_timeout(800)
pg2.locator('summary', has_text='Alerts and settings').click()
pg2.click('#alerts-on'); pg2.wait_for_timeout(800)
ok('Alerts are on' in pg2.inner_text('#alerts-text'), 'alerts turned on')
pushes = json.loads(urllib.request.urlopen(BASE + '/__pushes').read())
ok(pushes and pushes[-1]['title'] == 'Spending alerts are on', 'welcome push sent to the phone')
http('POST', '/api/log', {'merchant': 'Cineplex', 'amount': '20'}, auth=code)
pushes = json.loads(urllib.request.urlopen(BASE + '/__pushes').read())
ok(pushes[-1]['title'].startswith('Still over') or pushes[-1]['title'].startswith('Over'), 'over-limit alert pushed: ' + pushes[-1]['body'])
pg2.close()

# 6. Offline: saved copy shown
pg.route('**/api/**', lambda route: route.abort())
pg.click('.sp-refresh'); pg.wait_for_timeout(800)
ok(vis('#offline-note') and t('[data-draw=h_amt]') != '—', 'offline shows the saved copy')
pg.unroute('**/api/**')
pg.click('.sp-refresh'); pg.wait_for_timeout(800)
ok(not vis('#offline-note'), 'back online')

# 7. Another person sees nothing of Ana's
pg3 = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
pg3.add_init_script("window.__who = 'good-bo';" + FAKE_GOOGLE)
pg3.goto(BASE + '/'); pg3.wait_for_timeout(500); pg3.click('#fake-google'); pg3.wait_for_timeout(700)
pg3.click('#onboard-done'); pg3.wait_for_timeout(800)
ok(pg3.inner_text('[data-draw=h_amt]').replace('\n', '') == '$0.00', 'Bo sees $0.00, none of Ana\'s data')

# 8. Sign out everywhere kicks old sessions; sign back in skips setup
pg.locator('summary', has_text='Alerts and settings').click()
pg.click('#sign-out-all'); pg.wait_for_timeout(700)
ok(vis('#signin') and 'every phone' in t('#signin-error'), 'signed out everywhere')
ok(pg.evaluate("localStorage.getItem('spend.cache')") is None, 'saved copy removed on sign-out')
pg.click('#fake-google'); pg.wait_for_timeout(900)
ok(vis('#app'), 'returning person goes straight to the app')

# 9. Delete account
pg.evaluate("document.querySelector('#settings-details').open = true")
pg.click('#delete-account'); pg.wait_for_timeout(200)
ok('cannot be undone' in t('#acct-note'), 'delete asks first')
pg.click('#delete-account'); pg.wait_for_timeout(800)
ok(vis('#signin') and 'deleted' in t('#signin-error'), 'account deleted')
left = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + '/__sql', data=b"select (select count(*) from users where email='ana@example.com')::int u, (select count(*) from purchases)::int p, (select count(*) from devices)::int d", method='POST')).read())[0]
ok(left == {'u': 0, 'p': 0, 'd': 0}, 'Ana\'s account, purchases and phone are gone: ' + json.dumps(left))
s, r = http('POST', '/api/log', {'merchant': 'X', 'amount': '1'}, auth=code)
ok(s == 401, 'her old setup code no longer works')

ok(not errs, 'no page errors ' + json.dumps(errs))
print('\nALL PASSED:', passed)
b.close(); P.stop()
