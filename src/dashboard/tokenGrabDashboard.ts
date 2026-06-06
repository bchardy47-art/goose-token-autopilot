import path from 'node:path';
import { loadTokenGrabFixtures } from '../token-grab/fixtures';
import { buildTokenGrabReport } from '../token-grab/report';
import { buildTokenGrabAutopsyReport } from '../token-grab/autopsy';
import { loadAutopsyCandidatesFromFile, loadAutopsySnapshotsFromFile } from '../token-grab/autopsyLoaders';
import type { TokenGrabReport } from '../token-grab/types';
import type { TokenGrabAutopsyReport, TokenGrabAutopsyResult } from '../token-grab/autopsy';

const TOKEN_GRAB_FIXTURES_DIR = path.join(__dirname, '../../fixtures/token-grab');

export interface TokenGrabDashboardModel {
  generatedAt: string;
  earsReport: TokenGrabReport;
  autopsyReport: TokenGrabAutopsyReport;
}

/**
 * Loads fixture data and builds the Token Grab dashboard model.
 * Pure — no DB writes, no network calls, no GeckoTerminal fetch.
 */
export function buildTokenGrabDashboardModel(fixturesDir?: string): TokenGrabDashboardModel {
  const dir = fixturesDir ?? TOKEN_GRAB_FIXTURES_DIR;
  const fixtures = loadTokenGrabFixtures(dir);
  const earsReport = buildTokenGrabReport(fixtures);

  const autopsyCandidates = loadAutopsyCandidatesFromFile(
    path.join(dir, 'autopsy-candidates.json'),
  );
  const autopsySnapshots = loadAutopsySnapshotsFromFile(
    path.join(dir, 'autopsy-snapshots.json'),
  );
  const autopsyReport = buildTokenGrabAutopsyReport(autopsyCandidates, autopsySnapshots);

  return {
    generatedAt: new Date().toISOString(),
    earsReport,
    autopsyReport,
  };
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pill(text: string, color: 'green' | 'yellow' | 'red' | 'blue' | 'muted'): string {
  return `<span class="pill ${color}">${esc(text)}</span>`;
}

function lanePill(lane: string): string {
  const map: Record<string, 'green' | 'yellow' | 'red' | 'blue'> = {
    FRESH_LAUNCH_CANDIDATE: 'green',
    PRE_LAUNCH_WATCH: 'yellow',
    MEME_EVENT_CANDIDATE: 'blue',
    NOISE_RUG_LIKELY: 'red',
  };
  const color = map[lane] ?? 'yellow';
  return pill(lane.replace(/_/g, ' '), color);
}

function verdictPill(verdict: string): string {
  const map: Record<string, 'green' | 'yellow' | 'red' | 'muted'> = {
    GOOD_WATCH: 'green',
    GOOD_REJECT: 'green',
    BAD_REJECT: 'red',
    MISSED_RUN: 'yellow',
    NEEDS_MORE_DATA: 'yellow',
    NO_SIGNAL: 'muted',
  };
  const color = map[verdict] ?? 'yellow';
  return pill(verdict.replace(/_/g, ' '), color);
}

function kv(label: string, value: unknown): string {
  return `<div class="row kv"><strong>${esc(label)}</strong><span>${esc(String(value ?? 'N/A'))}</span></div>`;
}

function statBadge(label: string, n: number, color: 'green' | 'yellow' | 'red' | 'blue' | 'muted'): string {
  return `<div class="stat-badge ${color}"><div class="stat-n">${esc(String(n))}</div><div class="stat-label">${esc(label)}</div></div>`;
}

function renderAutopsyHighlight(result: TokenGrabAutopsyResult): string {
  const gainLine = result.maxGainPct != null
    ? `<div class="row muted small">Max gain: +${result.maxGainPct.toFixed(0)}%` +
      (result.firstRunAtMinutes != null ? ` · first run at ${result.firstRunAtMinutes}min` : '') + '</div>'
    : '';
  const drawLine = result.maxDrawdownPct != null
    ? `<div class="row muted small">Max drawdown: ${result.maxDrawdownPct.toFixed(0)}%</div>`
    : '';
  const lessons = result.lessons.slice(0, 2).map(l => `<li>${esc(l)}</li>`).join('');
  return `
    <div class="candidate-row">
      <div class="row"><strong>${esc('$' + result.ticker)}</strong> &nbsp; ${verdictPill(result.verdict)}</div>
      <div class="row muted small">${esc(result.lane.replace(/_/g, ' '))} · ${esc(result.decision)} · score ${esc(String(result.scoreAtDetection))}</div>
      ${gainLine}${drawLine}
      ${lessons ? `<ul class="compact-list">${lessons}</ul>` : ''}
    </div>`;
}

const CSS = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; overflow-x: hidden; }
    a { color: #93c5fd; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header { padding: 18px 20px 16px; background: #111827; position: sticky; top: 0; z-index: 10; border-bottom: 1px solid #1f2937; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    h3 { margin: 0 0 12px; font-size: 16px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
    .sub { color: #94a3b8; font-size: 13px; margin-top: 5px; }
    .header-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
    .header-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; border: 1px solid transparent; }
    .green { background: #14532d; color: #bbf7d0; }
    .yellow { background: #78350f; color: #fde68a; }
    .red { background: #7f1d1d; color: #fecaca; }
    .blue { background: #172554; color: #bfdbfe; }
    .muted { background: #1e293b; color: #94a3b8; }
    .safety-notice { margin: 16px; padding: 14px 16px; border-radius: 10px; border: 1px solid #1e3a8a; background: #0b1733; color: #bfdbfe; font-size: 13px; }
    .section { margin: 0 16px 20px; }
    .section-title { font-size: 18px; font-weight: 700; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #1f2937; }
    .stat-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    .stat-badge { padding: 10px 16px; border-radius: 10px; min-width: 90px; text-align: center; border: 1px solid rgba(255,255,255,0.06); }
    .stat-n { font-size: 28px; font-weight: 700; line-height: 1.1; }
    .stat-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 4px; }
    .candidate-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .candidate-row { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 14px; }
    .row { margin: 6px 0; color: #cbd5e1; font-size: 14px; line-height: 1.4; }
    .row.kv { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .row.kv strong { color: #e2e8f0; }
    .row.kv span { color: #94a3b8; text-align: right; }
    .row.muted { color: #64748b; }
    .row.small { font-size: 12px; }
    .compact-list { list-style: disc; padding-left: 16px; margin: 6px 0 0; }
    .compact-list li { margin: 4px 0; color: #94a3b8; font-size: 12px; }
    .divider { height: 1px; background: #1f2937; margin: 12px 0; }
    .footer { margin: 32px 16px 24px; padding: 16px; border-radius: 12px; border: 1px solid #1f2937; background: #0b1220; font-size: 12px; color: #64748b; }
    button { background: #2563eb; color: white; border: 0; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 600; }
    button:hover { background: #1d4ed8; }
    .no-items { color: #64748b; font-size: 13px; font-style: italic; }
`;

export function renderTokenGrabDashboardPage(model: TokenGrabDashboardModel): string {
  const { earsReport, autopsyReport, generatedAt } = model;
  const s = earsReport.summary;
  const as = autopsyReport.summary;

  // ── Ears candidate cards ─────────────────────────────────────────────────
  const candidateCards = earsReport.candidates.length === 0
    ? '<div class="no-items">No candidates in current fixture bundle.</div>'
    : earsReport.candidates.map(c => {
        const name = [c.ticker ? `$${c.ticker}` : null, c.tokenName].filter(Boolean).join(' — ');
        const redFlagCount = c.redFlags.length;
        return `
        <div class="candidate-row">
          <div class="row"><strong>${esc(name)}</strong></div>
          <div class="row">${lanePill(c.lane)} &nbsp; <span class="pill muted">${esc(c.decision)}</span></div>
          ${kv('Score', `${c.score}/100`)}
          ${kv('Social signals', c.matchedSocialSignals.length)}
          ${kv('Event signals', c.matchedEventSignals.length)}
          ${redFlagCount > 0 ? kv('Red flags', redFlagCount) : ''}
          <div class="row muted small">NO TRADING EXECUTED</div>
        </div>`;
      }).join('');

  // ── Autopsy highlight lists ──────────────────────────────────────────────
  const badRejects = autopsyReport.results.filter(r => r.verdict === 'BAD_REJECT');
  const goodWatches = autopsyReport.results.filter(r => r.verdict === 'GOOD_WATCH');

  const badRejectHtml = badRejects.length === 0
    ? '<div class="no-items">None in current fixture set.</div>'
    : badRejects.map(renderAutopsyHighlight).join('');

  const goodWatchHtml = goodWatches.length === 0
    ? '<div class="no-items">None in current fixture set.</div>'
    : goodWatches.map(renderAutopsyHighlight).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Token Grab Ears — Control Center</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <h1>Token Grab Ears</h1>
        <div class="sub">Read-only research dashboard &mdash; <a href="/">← Main Dashboard</a></div>
        <div class="sub">Fixture data &mdash; generated ${esc(generatedAt)} &nbsp; <button onclick="window.location.reload()">Refresh</button></div>
      </div>
      <div class="header-meta">
        <span class="pill red">REAL TRADING LOCKED</span>
        <span class="pill blue">REPORT ONLY</span>
        <span class="pill yellow">FIXTURE-ONLY</span>
        <span class="pill muted">NO TRADING EXECUTED</span>
      </div>
    </div>
  </header>

  <div class="safety-notice">
    &#x1F512; Token Grab Ears is report-only. No positions are opened. No DB writes. No live GeckoTerminal fetch.
    All data below is from local fixture files. Trading is locked.
  </div>

  <div class="section">
    <div class="section-title">Ears Summary</div>
    <div class="stat-grid">
      ${statBadge('Pre-launch Watch', s.prelaunchWatch, 'yellow')}
      ${statBadge('Fresh Launch', s.freshLaunchCandidates, 'green')}
      ${statBadge('Meme Event', s.memeEventCandidates, 'blue')}
      ${statBadge('Noise / Reject', s.rejectedNoise, 'red')}
      ${statBadge('Trading Executed', s.tradingExecuted, 'muted')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Fixture Bundle Candidates</div>
    <div class="candidate-grid">
      ${candidateCards}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Autopsy Summary</div>
    <div class="stat-grid">
      ${statBadge('Reviewed', as.candidatesReviewed, 'muted')}
      ${statBadge('Ran', as.ran, 'green')}
      ${statBadge('Died', as.died, 'red')}
      ${statBadge('Too Early', as.tooEarly, 'yellow')}
      ${statBadge('Good Watches', as.goodWatches, 'green')}
      ${statBadge('Good Rejects', as.goodRejects, 'green')}
      ${statBadge('Bad Rejects', as.badRejects, 'red')}
      ${statBadge('Needs Data', as.insufficientData + as.tooEarly, 'muted')}
      ${statBadge('Trading Executed', as.tradingExecuted, 'muted')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Autopsy Highlights — Bad Rejects</div>
    <div class="row muted small">Candidates we rejected (NOISE_RUG_LIKELY) that later ran. Use to improve scoring — do NOT loosen gates automatically.</div>
    <br/>
    <div class="candidate-grid">
      ${badRejectHtml}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Autopsy Highlights — Good Watches</div>
    <div class="row muted small">Candidates we flagged (FRESH_LAUNCH_CANDIDATE) that later ran as expected.</div>
    <br/>
    <div class="candidate-grid">
      ${goodWatchHtml}
    </div>
  </div>

  <div class="footer">
    <strong>Safety</strong><br/>
    Report-only &mdash; No DB writes &mdash; No scheduler &mdash; No trading execution &mdash;
    Gecko live fetch is NOT automatic on this page &mdash; Real trading remains locked.<br/>
    All candidate data is from local fixture files. Verdicts are for research only.
    Do not use autopsy verdicts to loosen trading gates automatically.
  </div>
</body>
</html>`;
}
