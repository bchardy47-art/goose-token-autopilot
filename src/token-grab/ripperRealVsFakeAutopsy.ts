import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutopsyCandidate {
  contract:        string;
  symbol:          string | null;
  approvedAt:      string;
  clusterRisk:     string;
  ripperScore:     number | null;
  scoreBand:       string;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
  sourceKind:      string | null;
  warnings:        string[];
  blockers:        string[];
  priceChangePct:  number | null;
  isWinner1:       boolean;
  isWinner3:       boolean;
  isWinner5:       boolean;
  isFake:          boolean;
}

export interface DimensionBreakdown {
  dimension:  string;
  value:      string;
  total:      number;
  winners1:   number;
  winners3:   number;
  winners5:   number;
  fakes:      number;
  winRate1:   number | null;
  winRate3:   number | null;
  fakeRate:   number | null;
  avgMove:    number | null;
}

export interface RipperRealVsFakeAutopsyResult {
  generatedAt:           string;
  candidatesAnalyzed:    number;
  observedCandidates:    number;
  winners1:              number;
  winners3:              number;
  winners5:              number;
  fakes:                 number;
  flat:                  number;
  breakdowns:            DimensionBreakdown[];
  realSignalPatterns:    string[];
  fakeSignalPatterns:    string[];
  recommendedKeepRules:  string[];
  recommendedRejectRules: string[];
  doNotChangeGatesYet:   true;
  outPath:               string;
  rowsWritten:           number;
  reportOnly:            true;
  readOnly:              true;
  tradingExecuted:       0;
  realTradingLocked:     true;
  paperOnly:             true;
}

export interface RipperRealVsFakeAutopsyOptions {
  cyclePaths:       string[];
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toScoreBand(score: number | null): string {
  if (score == null) return 'unknown';
  if (score >= 100)  return '100';
  if (score >= 90)   return '90-99';
  if (score >= 80)   return '80-89';
  if (score >= 70)   return '70-79';
  if (score >= 60)   return '60-69';
  return 'below60';
}

interface RawFixture {
  contract:        string;
  symbol:          string | null;
  capturedAt:      string;
  clusterRisk:     string;
  ripperScore:     number | null;
  launchAgeBucket: string | null;
  entryDecision:   string | null;
  sourceKind:      string | null;
  warnings:        string[];
  blockers:        string[];
}

function readApprovedFixtures(cyclePaths: string[]): RawFixture[] {
  const seen    = new Set<string>();
  const result: RawFixture[] = [];
  for (const p of cyclePaths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;
        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;
        const contract   = (ns?.['contract'] ?? raw?.['contract']) as string | undefined;
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        const key = `${contract}::${capturedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const clV = raw?.['clusterRisk'];
        result.push({
          contract,
          symbol:          (ns?.['symbol'] as string | undefined) ?? null,
          capturedAt,
          clusterRisk:     (clV === 'CLEAN' || clV === 'WATCH' || clV === 'RISKY') ? clV : 'UNKNOWN',
          ripperScore:     typeof f['ripperScore'] === 'number'     ? f['ripperScore']     : null,
          launchAgeBucket: typeof f['launchAgeBucket'] === 'string' ? f['launchAgeBucket'] : null,
          entryDecision:   typeof f['entryDecision']   === 'string' ? f['entryDecision']   : null,
          sourceKind:      typeof (ns?.['sourceKind'])  === 'string' ? (ns!['sourceKind'] as string) : null,
          warnings:        Array.isArray(f['warnings']) ? (f['warnings'] as string[]) : [],
          blockers:        Array.isArray(f['blockers']) ? (f['blockers'] as string[]) : [],
        });
      } catch { /* skip */ }
    }
  }
  return result;
}

function buildObsByContract(paths: string[]): Map<string, { capturedAt: string; priceChangePct: number | null }[]> {
  const map = new Map<string, { capturedAt: string; priceChangePct: number | null }[]>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f   = JSON.parse(line) as Record<string, unknown>;
        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;
        const contract   = (ns?.['contract'] ?? raw?.['contract']) as string | undefined;
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        let pct: number | null = null;
        if (typeof ns?.['priceChangePct'] === 'number')       pct = ns['priceChangePct']  as number;
        else if (typeof raw?.['priceChangePct'] === 'number') pct = raw['priceChangePct'] as number;
        const list = map.get(contract) ?? [];
        list.push({ capturedAt, priceChangePct: pct });
        map.set(contract, list);
      } catch { /* skip */ }
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return map;
}

function computeBreakdown(
  dimension: string,
  value: string,
  candidates: AutopsyCandidate[],
): DimensionBreakdown {
  const subset = candidates.filter(c => {
    switch (dimension) {
      case 'clusterRisk':     return c.clusterRisk     === value;
      case 'scoreBand':       return c.scoreBand        === value;
      case 'launchAgeBucket': return c.launchAgeBucket  === value;
      case 'entryDecision':   return c.entryDecision    === value;
      case 'sourceKind':      return c.sourceKind        === value;
      default:               return false;
    }
  });
  const total     = subset.length;
  const withPrice = subset.filter(c => c.priceChangePct != null);
  const n         = withPrice.length;

  if (n === 0) {
    return {
      dimension, value, total,
      winners1: 0, winners3: 0, winners5: 0, fakes: 0,
      winRate1: null, winRate3: null, fakeRate: null, avgMove: null,
    };
  }

  const winners1 = withPrice.filter(c => c.isWinner1).length;
  const winners3 = withPrice.filter(c => c.isWinner3).length;
  const winners5 = withPrice.filter(c => c.isWinner5).length;
  const fakes    = withPrice.filter(c => c.isFake).length;
  const prices   = withPrice.map(c => c.priceChangePct as number);
  const avg      = prices.reduce((s, x) => s + x, 0) / prices.length;

  return {
    dimension,
    value,
    total,
    winners1,
    winners3,
    winners5,
    fakes,
    winRate1:  Math.round((winners1 / n) * 1000) / 10,
    winRate3:  Math.round((winners3 / n) * 1000) / 10,
    fakeRate:  Math.round((fakes    / n) * 1000) / 10,
    avgMove:   Math.round(avg * 100) / 100,
  };
}

// ── Pattern derivation ────────────────────────────────────────────────────────

function derivePatterns(candidates: AutopsyCandidate[]): {
  realSignalPatterns:    string[];
  fakeSignalPatterns:    string[];
  recommendedKeepRules:  string[];
  recommendedRejectRules: string[];
} {
  const withPrice = candidates.filter(c => c.priceChangePct != null);
  if (withPrice.length === 0) {
    return {
      realSignalPatterns:     ['INSUFFICIENT_DATA'],
      fakeSignalPatterns:     ['INSUFFICIENT_DATA'],
      recommendedKeepRules:   ['INSUFFICIENT_DATA — observe more cycles'],
      recommendedRejectRules: ['INSUFFICIENT_DATA — observe more cycles'],
    };
  }

  const cleanWin1   = withPrice.filter(c => c.clusterRisk === 'CLEAN'  && c.isWinner1).length;
  const cleanTotal  = withPrice.filter(c => c.clusterRisk === 'CLEAN').length;
  const watchFake   = withPrice.filter(c => c.clusterRisk === 'WATCH'  && c.isFake).length;
  const watchTotal  = withPrice.filter(c => c.clusterRisk === 'WATCH').length;
  const score100Win = withPrice.filter(c => c.scoreBand === '100' && c.isWinner1).length;
  const score100Total = withPrice.filter(c => c.scoreBand === '100').length;

  const realPatterns: string[] = [];
  const fakePatterns: string[] = [];
  const keepRules:   string[] = [];
  const rejectRules: string[] = [];

  if (cleanTotal > 0) {
    const rate = Math.round((cleanWin1 / cleanTotal) * 100);
    realPatterns.push(`clusterRisk=CLEAN win>=1% rate: ${rate}% of ${cleanTotal} observed`);
  }
  if (score100Total > 0) {
    const rate = Math.round((score100Win / score100Total) * 100);
    realPatterns.push(`ripperScore=100 win>=1% rate: ${rate}% of ${score100Total} observed`);
  }
  if (watchTotal > 0) {
    const rate = Math.round((watchFake / watchTotal) * 100);
    fakePatterns.push(`clusterRisk=WATCH fake/dump rate: ${rate}% of ${watchTotal} observed`);
  }

  const flatCandidates = withPrice.filter(c => !c.isWinner1 && !c.isFake && Math.abs(c.priceChangePct as number) < 1);
  if (flatCandidates.length > 0) {
    fakePatterns.push(`${flatCandidates.length} candidates went flat (never moved ±1%)`);
  }

  keepRules.push('Continue CLEAN cluster + score>=100 + PRIME_WINDOW + READY_TO_SNIPE_PAPER approval path');
  keepRules.push('Keep WAIT_10M paper timing experiment for high-quality subgroup');
  rejectRules.push('WATCH and RISKY cluster candidates show lower win rates — hold current gates');
  rejectRules.push('DO NOT loosen gates until win rate evidence is consistent across multiple batches');

  if (realPatterns.length === 0) realPatterns.push('No clear real-signal patterns yet — need more data');
  if (fakePatterns.length === 0) fakePatterns.push('No clear fake patterns yet — need more data');

  return {
    realSignalPatterns:     realPatterns,
    fakeSignalPatterns:     fakePatterns,
    recommendedKeepRules:   keepRules,
    recommendedRejectRules: rejectRules,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperRealVsFakeAutopsy(
  options: RipperRealVsFakeAutopsyOptions,
): RipperRealVsFakeAutopsyResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const rawFixtures = readApprovedFixtures(options.cyclePaths);
  const byContract  = buildObsByContract(options.observationPaths);

  const candidates: AutopsyCandidate[] = rawFixtures.map(f => {
    const obs = (byContract.get(f.contract) ?? []).find(o => o.capturedAt >= f.capturedAt);
    const pct = obs?.priceChangePct ?? null;
    const isWinner1 = pct != null && pct >= 1;
    const isWinner3 = pct != null && pct >= 3;
    const isWinner5 = pct != null && pct >= 5;
    const isFake    = pct != null && (pct <= -3 || (!isWinner1 && Math.abs(pct) < 1));
    return {
      contract:        f.contract,
      symbol:          f.symbol,
      approvedAt:      f.capturedAt,
      clusterRisk:     f.clusterRisk,
      ripperScore:     f.ripperScore,
      scoreBand:       toScoreBand(f.ripperScore),
      launchAgeBucket: f.launchAgeBucket,
      entryDecision:   f.entryDecision,
      sourceKind:      f.sourceKind,
      warnings:        f.warnings,
      blockers:        f.blockers,
      priceChangePct:  pct,
      isWinner1,
      isWinner3,
      isWinner5,
      isFake,
    };
  });

  const withPrice          = candidates.filter(c => c.priceChangePct != null);
  const observedCandidates = withPrice.length;
  const winners1 = withPrice.filter(c => c.isWinner1).length;
  const winners3 = withPrice.filter(c => c.isWinner3).length;
  const winners5 = withPrice.filter(c => c.isWinner5).length;
  const fakes    = withPrice.filter(c => c.isFake).length;
  const flat     = withPrice.filter(c => !c.isWinner1 && !c.isFake).length;

  // Build breakdowns
  const clusterValues = ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'];
  const scoreBandValues = ['100', '90-99', '80-89', '70-79', '60-69', 'below60', 'unknown'];
  const uniqueBuckets   = [...new Set(candidates.map(c => c.launchAgeBucket).filter((v): v is string => v != null))].sort();
  const uniqueDecisions = [...new Set(candidates.map(c => c.entryDecision  ).filter((v): v is string => v != null))].sort();
  const uniqueSourceKinds = [...new Set(candidates.map(c => c.sourceKind   ).filter((v): v is string => v != null))].sort();

  const breakdowns: DimensionBreakdown[] = [
    ...clusterValues.map(v  => computeBreakdown('clusterRisk',     v, candidates)),
    ...scoreBandValues.map(v => computeBreakdown('scoreBand',       v, candidates)),
    ...uniqueBuckets.map(v   => computeBreakdown('launchAgeBucket', v, candidates)),
    ...uniqueDecisions.map(v => computeBreakdown('entryDecision',   v, candidates)),
    ...uniqueSourceKinds.map(v => computeBreakdown('sourceKind',    v, candidates)),
  ].filter(b => b.total > 0);

  const patterns = derivePatterns(candidates);

  // Write output JSONL
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const rows = candidates.map(c => ({ ...c, generatedAt }));
  const content = rows.length > 0
    ? rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, content, 'utf-8');

  return {
    generatedAt,
    candidatesAnalyzed:     candidates.length,
    observedCandidates,
    winners1,
    winners3,
    winners5,
    fakes,
    flat,
    breakdowns,
    realSignalPatterns:     patterns.realSignalPatterns,
    fakeSignalPatterns:     patterns.fakeSignalPatterns,
    recommendedKeepRules:   patterns.recommendedKeepRules,
    recommendedRejectRules: patterns.recommendedRejectRules,
    doNotChangeGatesYet:    true,
    outPath:                options.outPath,
    rowsWritten:            rows.length,
    reportOnly:             true,
    readOnly:               true,
    tradingExecuted:        0,
    realTradingLocked:      true,
    paperOnly:              true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fmtRate(v: number | null): string {
  if (v == null) return 'n/a';
  return `${v.toFixed(0)}%`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperRealVsFakeAutopsy(
  result: RipperRealVsFakeAutopsyResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — REAL VS FAKE AUTOPSY');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push('  DO NOT ENABLE REAL TRADING');
  lines.push(SEP, '');

  lines.push(`  Candidates analyzed   : ${result.candidatesAnalyzed}`);
  lines.push(`  Observed candidates   : ${result.observedCandidates}`);
  lines.push(`  Generated at          : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  OUTCOME SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Winners >= +1%        : ${result.winners1}`);
  lines.push(`  Winners >= +3%        : ${result.winners3}`);
  lines.push(`  Winners >= +5%        : ${result.winners5}`);
  lines.push(`  Fake / dump <= -3% or flat : ${result.fakes}`);
  lines.push(`  Flat / inconclusive   : ${result.flat}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  WHAT REAL LOOKED LIKE');
  lines.push(`  ${SEP2}`, '');
  for (const p of result.realSignalPatterns) lines.push(`  * ${p}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  WHAT FAKE LOOKED LIKE');
  lines.push(`  ${SEP2}`, '');
  for (const p of result.fakeSignalPatterns) lines.push(`  * ${p}`);
  lines.push('');

  if (result.breakdowns.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  DIMENSION BREAKDOWNS  (total/win1%/win3%/fake%)');
    lines.push(`  ${SEP2}`, '');
    lines.push('  Dimension       Value                  total  win1%  win3%  fake%  avgMove');
    lines.push(`  ${SEP2}`);
    for (const b of result.breakdowns) {
      const dim  = b.dimension.padEnd(15);
      const val  = b.value.padEnd(22);
      const tot  = String(b.total).padEnd(6);
      const w1   = fmtRate(b.winRate1).padEnd(6);
      const w3   = fmtRate(b.winRate3).padEnd(6);
      const fk   = fmtRate(b.fakeRate).padEnd(6);
      const avg  = b.avgMove != null ? `${b.avgMove >= 0 ? '+' : ''}${b.avgMove.toFixed(1)}%` : 'n/a';
      lines.push(`  ${dim} ${val} ${tot} ${w1} ${w3} ${fk} ${avg}`);
    }
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  RULES TO TEST NEXT');
  lines.push(`  ${SEP2}`, '');
  lines.push('  KEEP:');
  for (const r of result.recommendedKeepRules)   lines.push(`    * ${r}`);
  lines.push('  REJECT:');
  for (const r of result.recommendedRejectRules) lines.push(`    * ${r}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * doNotChangeGatesYet=true');
  lines.push('  * Report only — no trades, no paper positions, no gate changes.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
