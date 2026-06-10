import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';
import type { SlippageRisk, LiquidityTradable } from './fixtureQuotePreview';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuotePreviewAuditOptions {
  inputPath?:  string;
  generatedAt?: string;
}

export interface QuotePreviewAuditResult {
  inputPath:                  string;
  inputMissing:               boolean;
  generatedAt:                string;
  fixturesTotal:              number;
  candidatesTotal:            number;
  quotedCount:                number;
  quotedOnlineCount:          number;
  quotedOfflineCount:         number;
  routeFoundCount:            number;
  slippageRiskCounts:         Record<SlippageRisk, number>;
  liquidityTradableCounts:    Record<LiquidityTradable, number>;
  missingQuoteApproved:       number;  // BUY_APPROVED_PAPER without quoteCheckedAt
  riskySlippageApproved:      number;  // BUY_APPROVED_PAPER with slippageRisk=RISKY
  watchSlippageApproved:      number;  // BUY_APPROVED_PAPER with slippageRisk=WATCH
  cleanSlippageApproved:      number;  // BUY_APPROVED_PAPER with slippageRisk=CLEAN
  tradingExecuted:            0;
  noRealTradeSent:            true;
  paperOnly:                  true;
  readOnly:                   true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRaw(f: LiveRipperFixture): Record<string, unknown> {
  return (f.raw as Record<string, unknown>) ?? {};
}

function getSlippageRisk(f: LiveRipperFixture): SlippageRisk {
  const v = getRaw(f)['slippageRisk'];
  if (v === 'CLEAN') return 'CLEAN';
  if (v === 'WATCH')  return 'WATCH';
  if (v === 'RISKY')  return 'RISKY';
  return 'UNKNOWN';
}

function getLiquidityTradable(f: LiveRipperFixture): LiquidityTradable {
  const v = getRaw(f)['liquidityTradable'];
  if (v === 'GOOD')    return 'GOOD';
  if (v === 'WATCH')   return 'WATCH';
  if (v === 'RISKY')   return 'RISKY';
  return 'UNKNOWN';
}

function isApproved(f: LiveRipperFixture): boolean {
  return (f.buyGateDecision ?? f.entryDecision ?? '') === 'BUY_APPROVED_PAPER';
}

// ── Main audit function ───────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

export function runQuotePreviewAudit(
  options: QuotePreviewAuditOptions = {},
): QuotePreviewAuditResult {
  const inputPath  = options.inputPath  ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const base: Omit<QuotePreviewAuditResult, 'inputPath' | 'inputMissing' | 'generatedAt'> = {
    fixturesTotal:           0,
    candidatesTotal:         0,
    quotedCount:             0,
    quotedOnlineCount:       0,
    quotedOfflineCount:      0,
    routeFoundCount:         0,
    slippageRiskCounts:      { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 },
    liquidityTradableCounts: { GOOD: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 },
    missingQuoteApproved:    0,
    riskySlippageApproved:   0,
    watchSlippageApproved:   0,
    cleanSlippageApproved:   0,
    tradingExecuted:         0,
    noRealTradeSent:         true,
    paperOnly:               true,
    readOnly:                true,
  };

  if (!fs.existsSync(inputPath)) {
    return { inputPath, inputMissing: true, generatedAt, ...base };
  }

  let fixtures: LiveRipperFixture[];
  try {
    fixtures = readFixturesFromJsonl(inputPath);
  } catch {
    return { inputPath, inputMissing: true, generatedAt, ...base };
  }

  const total = fixtures.length;
  base.fixturesTotal = total;

  for (const f of fixtures) {
    const raw = getRaw(f);
    const decision = f.buyGateDecision ?? f.entryDecision ?? '';

    const isCandidate = ['BUY_APPROVED_PAPER', 'READY_TO_SNIPE_PAPER', 'WATCH'].includes(decision);
    if (isCandidate) base.candidatesTotal++;

    const hasQuote    = raw['quoteCheckedAt'] !== undefined;
    const isOnline    = hasQuote && raw['quoteProvider'] !== 'offline';
    const isOffline   = hasQuote && raw['quoteProvider'] === 'offline';

    if (hasQuote) base.quotedCount++;
    if (isOnline) base.quotedOnlineCount++;
    if (isOffline) base.quotedOfflineCount++;

    if (hasQuote && raw['routeFound'] === true) base.routeFoundCount++;

    const slipRisk = getSlippageRisk(f);
    base.slippageRiskCounts[slipRisk]++;

    const liqTradable = getLiquidityTradable(f);
    base.liquidityTradableCounts[liqTradable]++;

    if (isApproved(f)) {
      if (!hasQuote)                      base.missingQuoteApproved++;
      if (slipRisk === 'RISKY')           base.riskySlippageApproved++;
      if (slipRisk === 'WATCH')           base.watchSlippageApproved++;
      if (slipRisk === 'CLEAN')           base.cleanSlippageApproved++;
    }
  }

  return { inputPath, inputMissing: false, generatedAt, ...base };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderQuotePreviewAuditReport(result: QuotePreviewAuditResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — QUOTE PREVIEW AUDIT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first:');
    lines.push('    npm run token:fixture-quote-preview');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const pct = (n: number, d: number) =>
    d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
  const total = result.fixturesTotal;

  lines.push('');
  lines.push(`  Input      : ${result.inputPath}`);
  lines.push(`  Generated  : ${result.generatedAt}`);
  lines.push('');

  lines.push('  FIXTURE OVERVIEW');
  lines.push(`  Total fixtures       : ${total}`);
  lines.push(`  Candidates           : ${result.candidatesTotal}`);
  lines.push(`  Quoted (any)         : ${result.quotedCount}  (${pct(result.quotedCount, total)} of all)`);
  lines.push(`  Quoted (online)      : ${result.quotedOnlineCount}`);
  lines.push(`  Quoted (offline)     : ${result.quotedOfflineCount}`);
  lines.push(`  Route found          : ${result.routeFoundCount}`);
  lines.push('');

  lines.push('  SLIPPAGE RISK DISTRIBUTION');
  for (const risk of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'] as const) {
    const n = result.slippageRiskCounts[risk];
    lines.push(`    ${risk.padEnd(8)} : ${String(n).padStart(4)}  ${pct(n, total).padStart(6)}`);
  }
  lines.push('');

  lines.push('  LIQUIDITY TRADABLE DISTRIBUTION');
  for (const lt of ['GOOD', 'WATCH', 'RISKY', 'UNKNOWN'] as const) {
    const n = result.liquidityTradableCounts[lt];
    lines.push(`    ${lt.padEnd(8)} : ${String(n).padStart(4)}  ${pct(n, total).padStart(6)}`);
  }
  lines.push('');

  const approvedMissing = result.missingQuoteApproved;
  const approvedRisky   = result.riskySlippageApproved;
  const approvedWatch   = result.watchSlippageApproved;
  const approvedClean   = result.cleanSlippageApproved;

  lines.push('  BUY_APPROVED_PAPER BREAKDOWN');
  lines.push(`    Missing quote data  : ${approvedMissing}`);
  lines.push(`    CLEAN slippage      : ${approvedClean}`);
  lines.push(`    WATCH slippage      : ${approvedWatch}`);
  lines.push(`    RISKY slippage      : ${approvedRisky}`);
  lines.push('');

  // Next step recommendation
  lines.push('  RECOMMENDED NEXT STEP');
  if (approvedMissing > 0 && result.quotedOnlineCount === 0) {
    lines.push(`  → ${approvedMissing} BUY_APPROVED_PAPER fixture(s) have no quote data.`);
    lines.push('     Run: npm run token:fixture-quote-preview');
  } else if (approvedRisky > 0) {
    lines.push(`  → ${approvedRisky} approved fixture(s) have RISKY slippage — review before live trading.`);
    lines.push('     Run: npm run token:prime-gate-audit -- --strict-preview');
  } else if (approvedWatch > 0) {
    lines.push(`  → ${approvedWatch} approved fixture(s) have WATCH slippage — acceptable for paper.`);
    lines.push('     Run: npm run token:prime-gate-audit -- --strict-preview');
  } else if (approvedClean > 0) {
    lines.push(`  → All ${approvedClean} approved fixture(s) have CLEAN slippage.`);
    lines.push('     Run: npm run token:prime-gate-audit -- --strict-preview');
  } else {
    lines.push('  → No BUY_APPROVED_PAPER fixtures yet — run the full learning loop.');
  }
  lines.push('');

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
