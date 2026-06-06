/**
 * Token Grab — P/L Tracker UI page (single self-contained HTML document).
 *
 * SAFETY:
 *  - Read-only. Polls the read-only /api/token-grab/* endpoints every few seconds.
 *  - Contains NO buy/sell controls and introduces no trade-execution path.
 *  - The live-trading LOCKED badge is always rendered in the status bar.
 *  - Detail-drawer "actions" are inert placeholders in V1 (clearly marked
 *    read-only) because no safe paper-write endpoint exists; they perform no
 *    state changes.
 */

export function renderPlTrackerPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Token Grab — P/L Tracker</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0f1a;
    --panel: #111827;
    --panel-2: #0d1424;
    --border: #1f2937;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --green: #34d399;
    --green-bg: #052e22;
    --red: #f87171;
    --red-bg: #2a0f12;
    --yellow: #fbbf24;
    --yellow-bg: #2a1d05;
    --blue: #60a5fa;
    --blue-bg: #0b1733;
    --gray: #64748b;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; background: var(--bg); color: var(--text); font-size: 14px; }
  a { color: var(--blue); }

  /* Status bar */
  header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 12px 18px; position: sticky; top: 0; z-index: 30; }
  .statusbar { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
  .brand { font-size: 18px; font-weight: 800; letter-spacing: 0.06em; }
  .status-item { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
  .status-item b { color: var(--text); font-weight: 600; }
  .spacer { flex: 1 1 auto; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; border: 1px solid transparent; white-space: nowrap; }
  .pill.locked { background: var(--red-bg); color: var(--red); border-color: #7f1d1d; }
  .pill.unlocked { background: var(--yellow-bg); color: var(--yellow); border-color: #78350f; }
  .pill.paper { background: var(--blue-bg); color: var(--blue); border-color: #1e3a8a; }
  .pill.green { background: var(--green-bg); color: var(--green); border-color: #065f46; }
  .pill.red { background: var(--red-bg); color: var(--red); border-color: #7f1d1d; }
  .pill.yellow { background: var(--yellow-bg); color: var(--yellow); border-color: #78350f; }
  .pill.gray { background: #131a2a; color: var(--gray); border-color: #243044; }
  .pill.blue { background: var(--blue-bg); color: var(--blue); border-color: #1e3a8a; }

  /* Summary cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; padding: 16px 18px 4px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .card .value { font-size: 24px; font-weight: 700; margin-top: 6px; line-height: 1.1; }
  .card .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .flat { color: var(--text); }

  /* Tabs */
  nav.tabs { display: flex; gap: 4px; padding: 12px 18px 0; flex-wrap: wrap; }
  .tab { padding: 8px 14px; border: 1px solid var(--border); border-bottom: none; border-radius: 8px 8px 0 0; background: var(--panel-2); color: var(--muted); cursor: pointer; font-weight: 600; font-size: 13px; }
  .tab.active { background: var(--panel); color: var(--text); border-color: var(--border); }

  main { padding: 0 18px 40px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 0 12px 12px 12px; padding: 6px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; }
  tbody tr:hover { background: #0e1626; }
  td.num { font-variant-numeric: tabular-nums; }
  .row-pos { box-shadow: inset 3px 0 0 var(--green); }
  .row-neg { box-shadow: inset 3px 0 0 var(--red); }

  .btn { background: #1f2a44; color: var(--text); border: 1px solid #2b3a5e; padding: 5px 10px; border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn:hover { background: #27365a; }
  .btn.ghost { background: transparent; }

  /* stat strip for closed trades */
  .statstrip { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 12px; }
  .stat { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat .label { font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; }
  .stat .value { font-size: 18px; font-weight: 700; margin-top: 4px; }

  /* states */
  .state { padding: 36px 16px; text-align: center; color: var(--muted); }
  .state.error { color: var(--red); }
  .banner-msg { margin: 8px 12px; padding: 8px 12px; border-radius: 8px; font-size: 12px; }
  .banner-msg.error { background: var(--red-bg); color: var(--red); border: 1px solid #7f1d1d; }
  .banner-msg.fixture { background: var(--yellow-bg); color: var(--yellow); border: 1px solid #78350f; }

  /* drawer */
  .drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 40; display: none; }
  .drawer-backdrop.open { display: block; }
  .drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(460px, 92vw); background: var(--panel); border-left: 1px solid var(--border); z-index: 41; transform: translateX(100%); transition: transform 0.18s ease; overflow-y: auto; }
  .drawer.open { transform: translateX(0); }
  .drawer h2 { margin: 0; font-size: 18px; }
  .drawer-head { padding: 16px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; background: var(--panel); }
  .drawer-body { padding: 14px 18px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid #16203400; }
  .kv .k { color: var(--muted); }
  .kv .v { text-align: right; word-break: break-all; }
  .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--blue); margin: 16px 0 6px; }
  .eventlog { font-size: 12px; }
  .eventlog div { padding: 4px 0; border-bottom: 1px solid var(--border); color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  .ro-note { font-size: 11px; color: var(--muted); margin-top: 8px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  footer { padding: 16px 18px 28px; color: var(--gray); font-size: 11px; }
</style>
</head>
<body>
<header>
  <div class="statusbar">
    <span class="brand">TOKEN GRAB</span>
    <span class="pill paper" id="modePill">Paper</span>
    <span class="pill locked" id="lockPill">LIVE TRADING: LOCKED</span>
    <span class="status-item">Source: <b id="sourceVal">…</b></span>
    <span class="spacer"></span>
    <span class="status-item">Last updated: <b id="updatedVal">…</b></span>
    <button class="btn ghost" id="refreshBtn">Refresh</button>
  </div>
</header>

<div id="topError"></div>

<section class="cards" id="cards">
  <div class="card"><div class="label">Today P/L</div><div class="value flat" id="cardToday">…</div><div class="sub" id="cardTodaySub">realized today + open</div></div>
  <div class="card"><div class="label">Open P/L</div><div class="value flat" id="cardOpen">…</div><div class="sub">unrealized, open positions</div></div>
  <div class="card"><div class="label">Closed P/L</div><div class="value flat" id="cardClosed">…</div><div class="sub">realized, all closed</div></div>
  <div class="card"><div class="label">Win Rate</div><div class="value flat" id="cardWin">…</div><div class="sub" id="cardWinSub">closed trades</div></div>
  <div class="card"><div class="label">Open Positions</div><div class="value flat" id="cardPositions">…</div><div class="sub">paper</div></div>
</section>

<nav class="tabs" id="tabs">
  <div class="tab active" data-tab="positions">Open Positions</div>
  <div class="tab" data-tab="trades">Closed Trades</div>
  <div class="tab" data-tab="radar">Radar</div>
  <div class="tab" data-tab="watchlist">Watchlist</div>
</nav>

<main>
  <div class="panel" id="panel"><div class="state">Loading…</div></div>
</main>

<footer>
  Read-only paper / simulated tracker. No DB writes. No trading execution. Real trading remains locked. Auto-refreshing every 4s.
</footer>

<div class="drawer-backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer-head"><h2 id="drawerTitle">Position</h2><button class="btn ghost" id="drawerClose">Close ✕</button></div>
  <div class="drawer-body" id="drawerBody"><div class="state">Loading…</div></div>
</aside>

<script>
(function () {
  var POLL_MS = 4000;
  var activeTab = 'positions';
  var timer = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function usd(v) {
    var n = num(v);
    if (n === null) return 'N/A';
    var sign = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 1000) return sign + '$' + Math.round(a).toLocaleString();
    if (a >= 1) return sign + '$' + a.toFixed(2);
    if (a === 0) return '$0.00';
    return sign + '$' + a.toPrecision(3);
  }
  function pct(v) { var n = num(v); return n === null ? 'N/A' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function price(v) {
    var n = num(v);
    if (n === null) return 'N/A';
    if (n >= 1) return '$' + n.toFixed(4);
    return '$' + n.toPrecision(4);
  }
  function cls(v) { var n = num(v); if (n === null) return 'flat'; return n > 0 ? 'pos' : (n < 0 ? 'neg' : 'flat'); }
  function timeLabel(iso) {
    if (!iso) return 'N/A';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString();
  }
  function verdictPill(v) {
    var s = String(v || '').toUpperCase();
    var color = 'gray';
    if (s.indexOf('GOOD') >= 0 || s === 'WATCH' || s === 'PAPER_BUY' || s === 'AUTOPILOT_ELIGIBLE') color = 'green';
    else if (s.indexOf('BAD') >= 0 || s.indexOf('REJECT') >= 0 || s === 'AVOID') color = 'red';
    else if (s === 'ALERT_ONLY') color = 'yellow';
    return '<span class="pill ' + color + '">' + esc(v) + '</span>';
  }

  function setTopError(msg) {
    var el = document.getElementById('topError');
    el.innerHTML = msg ? '<div class="banner-msg error">' + esc(msg) + '</div>' : '';
  }

  async function getJson(url) {
    var res = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  async function loadDashboard() {
    try {
      var d = await getJson('/api/token-grab/dashboard');
      var sb = d.statusBar || {};
      var s = d.summary || {};
      document.getElementById('modePill').textContent = sb.mode || 'Paper';
      var lock = document.getElementById('lockPill');
      if (sb.liveTradingLocked === false) {
        lock.textContent = 'LIVE TRADING: UNLOCKED';
        lock.className = 'pill unlocked';
      } else {
        lock.textContent = 'LIVE TRADING: LOCKED';
        lock.className = 'pill locked';
      }
      document.getElementById('sourceVal').textContent = sb.source || 'N/A';
      document.getElementById('updatedVal').textContent = timeLabel(sb.generatedAt);

      setCard('cardToday', usd(s.todayPlUsd), cls(s.todayPlUsd));
      document.getElementById('cardTodaySub').textContent = 'realized today ' + usd(s.todayRealizedUsd) + ' + open';
      setCard('cardOpen', usd(s.openPlUsd), cls(s.openPlUsd));
      setCard('cardClosed', usd(s.closedPlUsd), cls(s.closedPlUsd));
      setCard('cardWin', s.winRatePct === null || s.winRatePct === undefined ? 'N/A' : s.winRatePct.toFixed(1) + '%', 'flat');
      document.getElementById('cardWinSub').textContent = (s.closedTrades || 0) + ' closed trades';
      setCard('cardPositions', String(s.openPositions != null ? s.openPositions : 'N/A'), 'flat');
      setTopError('');
    } catch (e) {
      setTopError('Dashboard failed to load: ' + (e && e.message ? e.message : e));
    }
  }
  function setCard(id, text, klass) {
    var el = document.getElementById(id);
    el.textContent = text;
    el.className = 'value ' + klass;
  }

  function emptyState(msg) { return '<div class="state">' + esc(msg) + '</div>'; }
  function errorState(msg) { return '<div class="state error">' + esc(msg) + '</div>'; }
  function fixtureBanner(src) {
    return src === 'fixture' ? '<div class="banner-msg fixture">Showing fixture sample data — no live rows available yet.</div>' : '';
  }

  function renderPositions(d) {
    var rows = d.positions || [];
    if (!rows.length) return emptyState('No open paper positions.');
    var body = rows.map(function (p) {
      var rc = p.plUsd > 0 ? 'row-pos' : (p.plUsd < 0 ? 'row-neg' : '');
      return '<tr class="' + rc + '">' +
        '<td><b>' + esc(p.token) + '</b></td>' +
        '<td class="num">' + price(p.entryPriceUsd) + '</td>' +
        '<td class="num">' + price(p.currentPriceUsd) + '</td>' +
        '<td class="num">' + usd(p.positionSizeUsd) + '</td>' +
        '<td class="num ' + cls(p.plUsd) + '">' + usd(p.plUsd) + '</td>' +
        '<td class="num ' + cls(p.plPct) + '">' + pct(p.plPct) + '</td>' +
        '<td class="num">' + esc(p.ageLabel) + '</td>' +
        '<td>' + esc(p.exitStatus) + '</td>' +
        '<td><button class="btn" data-inspect="' + esc(p.id) + '">Inspect</button></td>' +
        '</tr>';
    }).join('');
    return '<table><thead><tr>' +
      '<th>Token</th><th>Entry</th><th>Current</th><th>Size</th><th>P/L $</th><th>P/L %</th><th>Age</th><th>Exit Rule / Status</th><th>Actions</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderTrades(d) {
    var st = d.stats || {};
    var strip = '<div class="statstrip">' +
      stat('Total Closed', st.totalClosed != null ? st.totalClosed : 'N/A', 'flat') +
      stat('Win Rate', st.winRatePct === null || st.winRatePct === undefined ? 'N/A' : st.winRatePct.toFixed(1) + '%', 'flat') +
      stat('Avg Win', usd(st.averageWinUsd), 'pos') +
      stat('Avg Loss', usd(st.averageLossUsd), 'neg') +
      stat('Best', usd(st.bestTradeUsd), 'pos') +
      stat('Worst', usd(st.worstTradeUsd), 'neg') +
      stat('Net P/L', usd(st.netPlUsd), cls(st.netPlUsd)) +
      '</div>';
    var rows = d.trades || [];
    if (!rows.length) return strip + emptyState('No closed paper trades yet.');
    var body = rows.map(function (t) {
      var rc = t.plUsd > 0 ? 'row-pos' : (t.plUsd < 0 ? 'row-neg' : '');
      return '<tr class="' + rc + '">' +
        '<td><b>' + esc(t.token) + '</b></td>' +
        '<td class="num">' + price(t.entryPriceUsd) + '</td>' +
        '<td class="num">' + price(t.exitPriceUsd) + '</td>' +
        '<td class="num ' + cls(t.plUsd) + '">' + usd(t.plUsd) + '</td>' +
        '<td class="num ' + cls(t.plPct) + '">' + pct(t.plPct) + '</td>' +
        '<td class="num">' + esc(t.holdLabel) + '</td>' +
        '<td>' + esc(t.entryReason || '—') + '</td>' +
        '<td>' + esc(t.exitReason || '—') + '</td>' +
        '</tr>';
    }).join('');
    return strip + '<table><thead><tr>' +
      '<th>Token</th><th>Entry</th><th>Exit</th><th>P/L $</th><th>P/L %</th><th>Hold</th><th>Entry Reason</th><th>Exit Reason</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }
  function stat(label, value, klass) {
    return '<div class="stat"><div class="label">' + esc(label) + '</div><div class="value ' + klass + '">' + esc(value) + '</div></div>';
  }

  function renderRadar(d) {
    var rows = d.candidates || [];
    var banner = fixtureBanner(d.source);
    if (!rows.length) return banner + emptyState('No fresh candidates on radar.');
    var body = rows.map(function (c) {
      return '<tr>' +
        '<td><b>' + esc(c.token) + '</b></td>' +
        '<td class="num">' + esc(c.ageLabel) + '</td>' +
        '<td class="num">' + usd(c.liquidityUsd) + '</td>' +
        '<td class="num">' + usd(c.volumeUsd) + '</td>' +
        '<td class="num ' + cls(c.priceMovePct) + '">' + pct(c.priceMovePct) + '</td>' +
        '<td>' + verdictPill(c.verdict) + '</td>' +
        '<td>' + (c.blockers && c.blockers.length ? esc(c.blockers.join(', ')) : '<span class="pill gray">none</span>') + '</td>' +
        '<td><button class="btn" disabled title="Read-only in V1">Watch</button> ' +
            '<button class="btn" disabled title="Read-only in V1">Dismiss</button></td>' +
        '</tr>';
    }).join('');
    return banner + '<table><thead><tr>' +
      '<th>Token</th><th>Age</th><th>Liquidity</th><th>Volume</th><th>Price Move</th><th>Verdict</th><th>Blockers</th><th>Actions</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderWatchlist(d) {
    var rows = d.entries || [];
    var banner = fixtureBanner(d.source);
    if (!rows.length) return banner + emptyState('Watchlist is empty.');
    var body = rows.map(function (w) {
      return '<tr>' +
        '<td><b>' + esc(w.token) + '</b></td>' +
        '<td>' + timeLabel(w.watchedAt) + '</td>' +
        '<td>' + esc(w.reason || '—') + '</td>' +
        '<td class="num ' + cls(w.currentMovePct) + '">' + pct(w.currentMovePct) + '</td>' +
        '<td>' + (w.blockers && w.blockers.length ? esc(w.blockers.join(', ')) : '<span class="pill gray">none</span>') + '</td>' +
        '<td class="num ' + cls(w.wouldHavePlPct) + '">' + pct(w.wouldHavePlPct) + '</td>' +
        '<td><button class="btn" disabled title="Read-only in V1">Dismiss</button></td>' +
        '</tr>';
    }).join('');
    return banner + '<table><thead><tr>' +
      '<th>Token</th><th>Watched At</th><th>Reason</th><th>Current Move</th><th>Blockers Left</th><th>Would-have P/L</th><th>Actions</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  var endpoints = {
    positions: { url: '/api/token-grab/positions', render: renderPositions },
    trades: { url: '/api/token-grab/trades', render: renderTrades },
    radar: { url: '/api/token-grab/radar', render: renderRadar },
    watchlist: { url: '/api/token-grab/watchlist', render: renderWatchlist }
  };

  async function loadTab() {
    var ep = endpoints[activeTab];
    var panel = document.getElementById('panel');
    try {
      var data = await getJson(ep.url);
      panel.innerHTML = ep.render(data);
      bindInspect();
    } catch (e) {
      panel.innerHTML = errorState('Failed to load ' + activeTab + ': ' + (e && e.message ? e.message : e));
    }
  }

  function bindInspect() {
    var btns = document.querySelectorAll('[data-inspect]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { openDrawer(this.getAttribute('data-inspect')); });
    }
  }

  async function openDrawer(id) {
    var bd = document.getElementById('backdrop');
    var dr = document.getElementById('drawer');
    bd.classList.add('open'); dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
    var body = document.getElementById('drawerBody');
    body.innerHTML = '<div class="state">Loading…</div>';
    try {
      var p = await getJson('/api/token-grab/positions/' + encodeURIComponent(id));
      document.getElementById('drawerTitle').textContent = p.token + ' — paper position';
      body.innerHTML = renderDetail(p);
    } catch (e) {
      body.innerHTML = errorState('Failed to load position: ' + (e && e.message ? e.message : e));
    }
  }
  function kv(k, v) { return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
  function renderDetail(p) {
    var log = (p.eventLog || []).map(function (e) {
      return '<div>' + timeLabel(e.observedAt) + ' · ' + price(e.priceUsd) + ' · <span class="' + cls(e.unrealizedPnlUsd) + '">' + usd(e.unrealizedPnlUsd) + ' (' + pct(e.unrealizedPnlPct) + ')</span></div>';
    }).join('') || '<div>No snapshots recorded.</div>';
    return '' +
      kv('Token / symbol', esc(p.token)) +
      kv('Pair / mint', '<span class="mono">' + esc(p.mint) + '</span>') +
      kv('Mode', esc(p.mode)) +
      kv('Status', esc(p.status)) +
      kv('Entry price', price(p.entryPriceUsd)) +
      kv('Current price', price(p.currentPriceUsd)) +
      kv('Position size', usd(p.positionSizeUsd)) +
      kv('Quantity', p.quantity != null ? esc(p.quantity) : 'N/A') +
      kv('Open P/L $', '<span class="' + cls(p.plUsd) + '">' + usd(p.plUsd) + '</span>') +
      kv('Open P/L %', '<span class="' + cls(p.plPct) + '">' + pct(p.plPct) + '</span>') +
      kv('Best gain %', pct(p.bestGainPct)) +
      kv('Worst drawdown %', pct(p.worstDrawdownPct)) +
      kv('Opened at', timeLabel(p.openedAt)) +
      kv('Age', esc(p.ageLabel)) +
      kv('Source', esc(p.source)) +
      kv('Entry reason', esc(p.entryReason || '—')) +
      kv('Exit guidance', esc(p.exitGuidance)) +
      '<div class="section-label">Event log</div><div class="eventlog">' + log + '</div>' +
      '<div class="section-label">Actions</div>' +
      '<div class="actions">' +
        '<button class="btn" disabled title="Read-only in V1">Close Paper Position</button>' +
        '<button class="btn" disabled title="Read-only in V1">Mark Bad Entry</button>' +
        '<button class="btn" disabled title="Read-only in V1">Add Note</button>' +
        '<button class="btn ghost" id="drawerCloseBottom">Close</button>' +
      '</div>' +
      '<div class="ro-note">Paper actions are disabled in V1 (read-only). No real buy/sell controls exist. Live trading remains locked.</div>';
  }

  function closeDrawer() {
    document.getElementById('backdrop').classList.remove('open');
    var dr = document.getElementById('drawer');
    dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true');
  }

  // Tab switching
  document.getElementById('tabs').addEventListener('click', function (ev) {
    var t = ev.target.closest('.tab');
    if (!t) return;
    activeTab = t.getAttribute('data-tab');
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i] === t);
    document.getElementById('panel').innerHTML = '<div class="state">Loading…</div>';
    loadTab();
  });

  document.getElementById('refreshBtn').addEventListener('click', function () { loadDashboard(); loadTab(); });
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  document.getElementById('backdrop').addEventListener('click', closeDrawer);
  document.body.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'drawerCloseBottom') closeDrawer();
  });

  function tick() { loadDashboard(); loadTab(); }
  tick();
  timer = setInterval(tick, POLL_MS);
})();
</script>
</body>
</html>`;
}
