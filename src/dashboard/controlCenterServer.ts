import http from 'node:http';
import { URL } from 'node:url';
import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { buildControlCenterSummary } from './controlCenterSummary';
import { buildTokenGrabDashboardModel, renderTokenGrabDashboardPage } from './tokenGrabDashboard';

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Goose Token Autopilot Control Center</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; overflow-x: hidden; }
    header { padding: 18px 20px 16px; background: #111827; position: sticky; top: 0; z-index: 10; border-bottom: 1px solid #1f2937; }
    h1 { margin: 0; font-size: 30px; line-height: 1.15; }
    .sub { color: #94a3b8; font-size: 14px; margin-top: 6px; }
    .header-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
    .header-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; border: 1px solid transparent; }
    .green { background: #14532d; color: #bbf7d0; }
    .yellow { background: #78350f; color: #fde68a; }
    .red { background: #7f1d1d; color: #fecaca; }
    .blue { background: #172554; color: #bfdbfe; }
    .status { margin: 16px; padding: 12px 14px; border-radius: 12px; border: 1px solid #334155; background: #0b1220; }
    .status.hidden { display: none; }
    .status.error { border-color: #7f1d1d; background: #220f16; color: #fecaca; }
    .status.info { border-color: #1e3a8a; background: #0b1733; color: #bfdbfe; }
    .banner { margin: 16px; padding: 18px; border-radius: 16px; border: 1px solid #334155; background: linear-gradient(135deg, #172554, #111827); }
    .banner-title { font-size: 24px; font-weight: 700; line-height: 1.2; margin: 0 0 8px; }
    .banner-reason { color: #cbd5e1; font-size: 14px; }
    .wrap { padding: 0 16px 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
    .card { min-width: 0; background: #111827; border: 1px solid #1f2937; border-radius: 14px; padding: 16px; min-height: 150px; overflow: hidden; }
    .card h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.25; }
    .card.guidance { border-color: #1d4ed8; box-shadow: inset 0 0 0 1px rgba(59,130,246,0.2); }
    .metric { font-size: 26px; font-weight: 700; margin: 4px 0 8px; line-height: 1.2; word-break: break-word; }
    .row { margin: 8px 0; color: #cbd5e1; font-size: 14px; line-height: 1.4; min-width: 0; overflow-wrap: anywhere; }
    .kv { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .kv strong { color: #e2e8f0; flex: 1 1 auto; min-width: 0; }
    .kv span { color: #cbd5e1; text-align: right; flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
    .muted { color: #94a3b8; }
    .small { font-size: 12px; }
    .stack { display: flex; flex-direction: column; gap: 8px; }
    .compact-list { list-style: disc; padding-left: 18px; margin: 8px 0 0; }
    .compact-list li { margin: 6px 0; color: #cbd5e1; }
    .divider { height: 1px; background: #1f2937; margin: 10px 0; }
    .label { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #93c5fd; margin-bottom: 6px; }
    button { background: #2563eb; color: white; border: 0; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-weight: 600; }
    button:hover { background: #1d4ed8; }
    @media (max-width: 640px) {
      h1 { font-size: 26px; }
      .banner-title { font-size: 20px; }
      .kv { flex-direction: column; gap: 2px; }
      .kv span { text-align: left; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <h1>Goose Token Autopilot</h1>
        <div class="sub">Dashboard Control Center</div>
        <div class="sub">Last updated: <span id="lastUpdated">loading…</span> · <button id="refreshBtn">Refresh now</button></div>
      </div>
      <div class="header-meta">
        <span class="pill red">REAL TRADING LOCKED</span>
        <span class="pill blue">READ ONLY</span>
        <span class="pill yellow">RESEARCH MODE</span>
      </div>
    </div>
  </header>
  <div id="errorPanel" class="status hidden" role="alert"></div>
  <div id="infoPanel" class="status info">Loading dashboard cards…</div>
  <section id="decisionBanner" class="banner">
    <div class="label">Operator Decision</div>
    <div class="banner-title">RESEARCH ONLY — No shadow matches, sample size too low</div>
    <div class="banner-reason">Waiting for live summary data…</div>
  </section>
  <div class="wrap" id="app">
    <section class="card"><h2>System Safety</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card"><h2>Radar / Intake</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card"><h2>Fresh Capture Coverage</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card"><h2>Shadow Match / Research Signal</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card"><h2>Paper Readiness</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card"><h2>Tiny Paper Plan Status</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card"><h2>Best / Worst Current Movers</h2><div class="row muted">Waiting for summary…</div></section>
    <section class="card guidance"><h2>Operator Guidance</h2><div class="row muted">Waiting for summary…</div></section>
  </div>
  <script>
    function pillClass(v) {
      if (v === true || v === 'GREEN' || v === 'ON' || v === 'READY_TO_CONSIDER') return 'pill green';
      if (v === false || v === 'RED' || v === 'OFF' || v === 'NOT_READY') return 'pill red';
      return 'pill yellow';
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>\"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; });
    }
    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }
    function asText(value, fallback) {
      if (value === null || value === undefined || value === '') return fallback || 'N/A';
      return String(value);
    }
    function asNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : null;
    }
    function fmtInt(value) {
      var n = asNumber(value);
      return n === null ? 'N/A' : String(Math.round(n));
    }
    function fmtPct(value) {
      var n = asNumber(value);
      return n === null ? 'N/A' : (Math.round(n * 10) / 10).toFixed(1) + '%';
    }
    function fmtUsd(value) {
      var n = asNumber(value);
      if (n === null) return 'N/A';
      if (n >= 1000) return '$' + Math.round(n).toLocaleString();
      if (n >= 1) return '$' + n.toFixed(2);
      return '$' + n.toPrecision(3);
    }
    function kv(label, value, small) {
      return '<div class="row kv' + (small ? ' small' : '') + '"><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(asText(value, 'N/A')) + '</span></div>';
    }
    function note(text) {
      return '<div class="row muted small">' + escapeHtml(asText(text, 'N/A')) + '</div>';
    }
    function list(items) {
      var values = asArray(items).slice(0, 5);
      if (!values.length) return '<div class="row muted">No items.</div>';
      return '<ul class="compact-list">' + values.map(function (item) { return '<li>' + escapeHtml(asText(item, 'N/A')) + '</li>'; }).join('') + '</ul>';
    }
    function rowsFromMap(map) {
      var obj = asObject(map);
      var entries = Object.entries(obj);
      if (!entries.length) return '<div class="row muted">N/A</div>';
      return entries.map(function (entry) { return kv(entry[0], entry[1], false); }).join('');
    }
    function rowsFromRanked(items) {
      var values = asArray(items);
      if (!values.length) return '<div class="row muted">N/A</div>';
      return values.map(function (item) {
        var row = asObject(item);
        return kv(asText(row.value, 'N/A'), fmtInt(row.count), false);
      }).join('');
    }
    function safeSymbol(row) {
      var item = asObject(row);
      if (item.symbol) return String(item.symbol);
      if (item.tokenId !== undefined && item.tokenId !== null) return 'tokenId ' + item.tokenId;
      return 'N/A';
    }
    function moverLine(label, row, mode) {
      var item = asObject(row);
      var reason = item.status || item.reason || 'N/A';
      var move = mode === 'best' ? fmtPct(item.bestGainPct) : fmtPct(item.worstDrawdownPct);
      var verb = mode === 'best' ? 'gain' : 'drawdown';
      return '<div class="stack">' +
        kv(label, safeSymbol(item), false) +
        kv(mode === 'best' ? 'Move' : 'Drawdown', move, false) +
        kv('Reason', reason, true) +
      '</div>';
    }
    function worstCoveredLine(row) {
      var item = asObject(row);
      if (!Object.keys(item).length) return '<div class="row muted">N/A</div>';
      var symbol = asText(item.symbol, 'N/A');
      return '<div class="row"><strong>' + escapeHtml(symbol) + '</strong> — done ' + escapeHtml(fmtInt(item.doneCount)) + ', due ' + escapeHtml(fmtInt(item.dueCount)) + ', wait ' + escapeHtml(fmtInt(item.waitCount)) + ', missed ' + escapeHtml(fmtInt(item.missedCount)) + '</div>' + note('Source: ' + asText(item.source, 'N/A'));
    }
    function limitedBullets(items) {
      return asArray(items).slice(0, 5).map(function (x) { return '<li>' + escapeHtml(asText(x, 'N/A')) + '</li>'; }).join('') || '<li>N/A</li>';
    }
    function decisionBanner(summary) {
      var safe = asObject(summary);
      var radarIntake = asObject(safe.radarIntake);
      var shadow = asObject(safe.shadowResearchSignal);
      var tiny = asObject(safe.tinyPaperPlan);
      var title = 'WAIT — No new actionable targets';
      var reason = 'No new summary signal is currently actionable.';
      if ((asNumber(shadow.shadowMatchCount) || 0) > 0) {
        title = 'REVIEW SHADOW MATCH — Candidate Needs Human Review';
        reason = asText(shadow.decisionNote, 'Shadow matches detected.');
      } else if ((asNumber(radarIntake.newOrUpdatedRecentWindow) || 0) > 0) {
        title = 'RUN CAPTURE — New / Updated Targets Detected';
        reason = fmtInt(radarIntake.newOrUpdatedRecentWindow) + ' new or updated target(s) detected in the recent window.';
      }
      if ((asNumber(shadow.shadowMatchCount) || 0) === 0 && /sample count still low/i.test(asText(tiny.status, ''))) {
        title = 'RESEARCH ONLY — No shadow matches, sample size too low';
        reason = 'No shadow matches right now, and tiny paper evidence is still below the minimum sample target.';
      }
      var banner = document.getElementById('decisionBanner');
      banner.innerHTML = '<div class="label">Operator Decision</div><div class="banner-title">' + escapeHtml(title) + '</div><div class="banner-reason">' + escapeHtml(reason) + '</div>';
    }
    function showError(message) {
      var panel = document.getElementById('errorPanel');
      panel.textContent = message;
      panel.className = 'status error';
    }
    function clearError() {
      var panel = document.getElementById('errorPanel');
      panel.textContent = '';
      panel.className = 'status hidden';
    }
    function setInfo(message) {
      var panel = document.getElementById('infoPanel');
      panel.textContent = message;
      panel.className = 'status info';
    }
    function hideInfo() {
      var panel = document.getElementById('infoPanel');
      panel.textContent = '';
      panel.className = 'status hidden';
    }
    function card(title, body, extraClass) { return '<section class="card ' + (extraClass || '') + '"><h2>' + escapeHtml(title) + '</h2>' + body + '</section>'; }
    function renderSummary(data) {
      var safe = asObject(data);
      var systemSafety = asObject(safe.systemSafety);
      var radarIntake = asObject(safe.radarIntake);
      var freshCaptureCoverage = asObject(safe.freshCaptureCoverage);
      var shadowResearchSignal = asObject(safe.shadowResearchSignal);
      var paperReadiness = asObject(safe.paperReadiness);
      var tinyPaperPlan = asObject(safe.tinyPaperPlan);
      var movers = asObject(safe.movers);
      var operatorGuidance = asObject(safe.operatorGuidance);
      var app = document.getElementById('app');
      decisionBanner(safe);
      app.innerHTML = [
        card('System Safety',
          '<div class="metric">' + escapeHtml(asText(systemSafety.finalSafetyStatus, 'N/A')) + '</div>' +
          '<div class="row"><span class="' + pillClass(systemSafety.realTradingLock) + '">REAL TRADING LOCKED ' + (systemSafety.realTradingLock ? 'ON' : 'OFF') + '</span> <span class="pill blue">READ ONLY</span></div>' +
          kv('Token source', systemSafety.tokenSource, false) +
          kv('Quote check', systemSafety.quoteCheckEnabled ? 'Enabled' : 'Disabled', false) +
          kv('Safety enrichment', systemSafety.solanaSafetyEnrichmentEnabled ? 'Enabled' : 'Disabled', false) +
          kv('Paper buys opened today', fmtInt(systemSafety.paperBuysOpenedToday), false) +
          kv('Open paper positions', fmtInt(systemSafety.openPaperPositions), false) +
          kv('Real trade attempts', fmtInt(systemSafety.realTradeAttempts), false)
        ),
        card('Radar / Intake',
          kv('Watch-only candidates', fmtInt(radarIntake.totalWatchOnlyCandidates), false) +
          kv('Candidates in last 24h', fmtInt(radarIntake.inWindowCandidates24h), false) +
          kv('New / updated recent window', fmtInt(radarIntake.newOrUpdatedRecentWindow), false) +
          kv('Outcomes recorded 24h', fmtInt(radarIntake.outcomesRecorded24h), false) +
          kv('Recent scan runs', fmtInt(radarIntake.recentScanRuns), false) +
          kv('Accepted in last window', fmtInt(radarIntake.scannedAcceptedInLastWindow), false) +
          '<div class="divider"></div>' +
          '<div class="label">Signal Class Counts</div>' + rowsFromMap(radarIntake.signalClassCounts) +
          '<div class="divider"></div>' +
          '<div class="label">Sources 24h</div>' + rowsFromMap(radarIntake.sourceBreakdown24h) +
          note('Latest watch-cycle intake: Not yet wired')
        ),
        card('Fresh Capture Coverage',
          '<div class="row"><span class="' + pillClass(freshCaptureCoverage.status) + '">' + escapeHtml(asText(freshCaptureCoverage.status, 'N/A')) + '</span></div>' +
          kv('Coverage', fmtPct(freshCaptureCoverage.coveragePct), false) +
          kv('Done windows', fmtInt(freshCaptureCoverage.done), false) +
          kv('Due windows', fmtInt(freshCaptureCoverage.due), false) +
          kv('Wait windows', fmtInt(freshCaptureCoverage.wait), false) +
          kv('Missed windows', fmtInt(freshCaptureCoverage.missed), false) +
          kv('In-window candidates', fmtInt(freshCaptureCoverage.inWindowCandidateCount), false) +
          '<div class="divider"></div>' +
          '<div class="label">Worst Covered Candidate</div>' + worstCoveredLine(freshCaptureCoverage.topWorstCoveredCandidate) +
          note(freshCaptureCoverage.note)
        ),
        card('Shadow Match / Research Signal',
          kv('Shadow matches', fmtInt(shadowResearchSignal.shadowMatchCount), false) +
          kv('Watch more', fmtInt(shadowResearchSignal.watchMoreCount), false) +
          kv('Rejected', fmtInt(shadowResearchSignal.rejectCount), false) +
          '<div class="divider"></div>' +
          '<div class="label">Top Rejection Reasons</div>' + rowsFromRanked(shadowResearchSignal.topRejectionReasons) +
          note(shadowResearchSignal.decisionNote)
        ),
        card('Paper Readiness',
          '<div class="row"><span class="' + pillClass(paperReadiness.verdict) + '">' + escapeHtml(asText(paperReadiness.verdict, 'N/A')) + '</span></div>' +
          kv('Passing gates', fmtInt(paperReadiness.gatesPassingCount) + ' / ' + fmtInt(paperReadiness.totalGates), false) +
          note(paperReadiness.verdictReason) +
          '<div class="divider"></div>' +
          '<div class="label">Blockers</div>' + list(paperReadiness.blockers) +
          '<div class="label">Warnings</div>' + list(paperReadiness.warnings)
        ),
        card('Tiny Paper Plan Status',
          '<div class="metric">' + escapeHtml(asText(tinyPaperPlan.status, 'N/A')) + '</div>' +
          kv('Shadow pass count', fmtInt(tinyPaperPlan.allTimeShadowPassCount), false) +
          kv('With forward capture', fmtInt(tinyPaperPlan.shadowPassWithForwardCaptureCount), false) +
          kv('Minimum sample target', fmtInt(tinyPaperPlan.minimumSampleTarget), false) +
          kv('Max paper position', fmtUsd(tinyPaperPlan.maxPaperPositionUsd), false) +
          kv('Max open positions', fmtInt(tinyPaperPlan.maxOpenPositions), false) +
          kv('Max daily paper buys', fmtInt(tinyPaperPlan.maxDailyPaperBuys), false)
        ),
        card('Best / Worst Current Movers',
          '<div class="label">Best</div>' + moverLine('Best', movers.bestCurrentMover, 'best') +
          '<div class="divider"></div>' +
          '<div class="label">Worst</div>' + moverLine('Worst', movers.worstCurrentMover, 'worst')
        ),
        card('Operator Guidance',
          '<div class="metric">' + escapeHtml(asText(operatorGuidance.headline, 'N/A')) + '</div>' +
          '<ul class="compact-list">' + limitedBullets(operatorGuidance.bullets) + '</ul>',
          'guidance'
        )
      ].join('');
    }
    async function load() {
      try {
        setInfo('Loading dashboard cards…');
        var res = await fetch('/api/summary');
        if (!res.ok) {
          throw new Error('Summary request failed with HTTP ' + res.status);
        }
        var data = await res.json();
        document.getElementById('lastUpdated').textContent = asText(data && data.generatedAt, 'N/A');
        renderSummary(data);
        clearError();
        hideInfo();
      } catch (error) {
        document.getElementById('lastUpdated').textContent = 'error';
        showError('Dashboard summary failed to load: ' + (error && error.message ? error.message : String(error)));
        try {
          renderSummary({
            generatedAt: null,
            systemSafety: { finalSafetyStatus: 'N/A', realTradingLock: true, autoPaperEnabled: null },
            radarIntake: { latestWatchCycleIntake: 'Not yet wired' },
            freshCaptureCoverage: { status: 'N/A' },
            shadowResearchSignal: {},
            paperReadiness: { verdict: 'N/A' },
            tinyPaperPlan: {},
            movers: {},
            operatorGuidance: { headline: 'N/A', bullets: ['Summary unavailable.'] }
          });
        } catch (renderError) {
          document.getElementById('app').innerHTML = card('Operator Guidance', '<div class="row">Summary unavailable.</div>', 'guidance');
          showError('Dashboard render failed: ' + (renderError && renderError.message ? renderError.message : String(renderError)));
        }
      }
    }
    document.getElementById('refreshBtn').addEventListener('click', load);
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}

export async function startControlCenterServer(db: AppDb, config: AppConfig, options: { port?: number } = {}): Promise<http.Server> {
  const port = options.port ?? 3030;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);

    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, readOnly: true }));
        return;
      }

      if (url.pathname === '/api/summary') {
        const summary = buildControlCenterSummary(db, config);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(summary, null, 2));
        return;
      }

      if (url.pathname === '/token-grab') {
        const model = buildTokenGrabDashboardModel();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderTokenGrabDashboardPage(model));
        return;
      }

      if (url.pathname === '/api/token-grab-summary') {
        const model = buildTokenGrabDashboardModel();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          generatedAt: model.generatedAt,
          readOnly: true,
          tradingExecuted: 0,
          geckoLiveFetch: false,
          earsSummary: model.earsReport.summary,
          autopsySummary: model.autopsyReport.summary,
        }, null, 2));
        return;
      }

      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage());
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(message);
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'control_center_request_failed', message }, null, 2));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return server;
}
