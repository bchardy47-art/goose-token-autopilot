import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SimCandidate {
  contractKey: string;
  symbol?: string;
  approvedAt: string;
  ageMinutes: number | null;
  score: number | null;
  priceChangePct: number | null;
  clusterRisk: string;
  entryPriceUsd: number | null;
}

export interface RuleResult {
  ruleName: string;
  ruleDescription: string;
  selectedCount: number;
  avgScore: number | null;
  avgAge: number | null;
  avgEntryPrice: number | null;
  clusterBreakdown: { CLEAN: number; WATCH: number; RISKY: number; UNKNOWN: number };
  matchedOutcomeCount: number;
  avgOutcomePctChange: number | null;
  winnersCount: number;
  losersCount: number;
}

export interface RipperEntrySimOptions {
  inputPaths: string[];
  outcomePaths?: string[];
  nowMs?: number;
}

export interface RipperEntrySimResult {
  generatedAt: string;
  cycleFilesRead: number;
  cycleFilesMissing: number;
  outcomeFilesRead: number;
  outcomeFilesMissing: number;
  fixturesScanned: number;
  uniqueApprovedCandidates: number;
  outcomeLookupSize: number;
  rules: RuleResult[];
  realTradingLocked: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Sim rules ─────────────────────────────────────────────────────────────────

interface SimRuleDef {
  name: string;
  description: string;
  test: (c: SimCandidate) => boolean;
}

export const SIM_RULES: readonly SimRuleDef[] = [
  {
    name:        'current-approved',
    description: 'current approved rule',
    test:        () => true,
  },
  {
    name:        'age-gte-5m',
    description: 'approval age >= 5m',
    test:        c => c.ageMinutes != null && c.ageMinutes >= 5,
  },
  {
    name:        'age-gte-8m',
    description: 'approval age >= 8m',
    test:        c => c.ageMinutes != null && c.ageMinutes >= 8,
  },
  {
    name:        'age-gte-10m',
    description: 'approval age >= 10m',
    test:        c => c.ageMinutes != null && c.ageMinutes >= 10,
  },
  {
    name:        'pct-gte-0',
    description: 'priceChangePct >= 0',
    test:        c => c.priceChangePct != null && c.priceChangePct >= 0,
  },
  {
    name:        'pct-gte-2',
    description: 'priceChangePct >= 2',
    test:        c => c.priceChangePct != null && c.priceChangePct >= 2,
  },
  {
    name:        'pct-gte-5',
    description: 'priceChangePct >= 5',
    test:        c => c.priceChangePct != null && c.priceChangePct >= 5,
  },
  {
    name:        'score100-pct-gte-0',
    description: 'score >= 100 AND priceChangePct >= 0',
    test:        c => (c.score ?? 0) >= 100 && c.priceChangePct != null && c.priceChangePct >= 0,
  },
  {
    name:        'clean-age5-pct0',
    description: 'CLEAN AND age >= 5m AND priceChangePct >= 0',
    test:        c => c.clusterRisk === 'CLEAN'
                   && c.ageMinutes != null && c.ageMinutes >= 5
                   && c.priceChangePct != null && c.priceChangePct >= 0,
  },
  {
    name:        'clean-age8-pct0',
    description: 'CLEAN AND age >= 8m AND priceChangePct >= 0',
    test:        c => c.clusterRisk === 'CLEAN'
                   && c.ageMinutes != null && c.ageMinutes >= 8
                   && c.priceChangePct != null && c.priceChangePct >= 0,
  },
];

// ── Extraction helpers ────────────────────────────────────────────────────────

function contractKeyOf(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function getClusterRisk(f: LiveRipperFixture): string {
  const raw = f.raw as Record<string, unknown> | undefined;
  const v   = raw?.['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

function getEntryPriceUsd(f: LiveRipperFixture): number | null {
  const raw   = f.normalizedSignal.raw as Record<string, unknown> | undefined;
  const entry = raw?.['entry'] as Record<string, unknown> | undefined;
  const price = entry?.['priceUsd'];
  return typeof price === 'number' ? price : null;
}

function toSimCandidate(f: LiveRipperFixture): SimCandidate {
  return {
    contractKey:  contractKeyOf(f.normalizedSignal),
    symbol:       f.normalizedSignal.symbol,
    approvedAt:   f.capturedAt,
    ageMinutes:   typeof f.ageMinutes === 'number' ? f.ageMinutes : null,
    score:        typeof f.ripperScore === 'number' ? f.ripperScore : null,
    priceChangePct: typeof f.normalizedSignal.priceChangePct === 'number'
      ? f.normalizedSignal.priceChangePct
      : null,
    clusterRisk:  getClusterRisk(f),
    entryPriceUsd: getEntryPriceUsd(f),
  };
}

// ── Avg helpers ───────────────────────────────────────────────────────────────

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEntrySim(options: RipperEntrySimOptions): RipperEntrySimResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Read cycle JSONL files ────────────────────────────────────────────────

  let cycleFilesRead    = 0;
  let cycleFilesMissing = 0;
  let fixturesScanned   = 0;

  const seen:       Set<string>       = new Set();
  const candidates: SimCandidate[]    = [];

  for (const inputPath of options.inputPaths) {
    if (!fs.existsSync(inputPath)) {
      cycleFilesMissing++;
      continue;
    }
    cycleFilesRead++;
    const fixtures = readFixturesFromJsonl(inputPath);
    fixturesScanned += fixtures.length;

    for (const f of fixtures) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const key = contractKeyOf(f.normalizedSignal);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(toSimCandidate(f));
    }
  }

  // ── Read outcome JSON files (optional) ───────────────────────────────────

  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;

  interface OutcomeEntry {
    pctChangeFromEntry: number | null;
    multipleFromEntry: number | null;
    checkpointAt: string;
  }
  const outcomeLookup = new Map<string, OutcomeEntry>();

  for (const outcomePath of options.outcomePaths ?? []) {
    if (!fs.existsSync(outcomePath)) {
      outcomeFilesMissing++;
      continue;
    }
    outcomeFilesRead++;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(outcomePath, 'utf-8'));
    } catch {
      continue;
    }

    const fileCkAt  = typeof parsed?.checkpointAt === 'string' ? parsed.checkpointAt : '';
    const rawCands  = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    for (const c of rawCands as Record<string, unknown>[]) {
      const key      = typeof c.contractKey === 'string' ? c.contractKey : null;
      if (!key) continue;
      const ckAt = typeof c.checkpointAt === 'string' ? c.checkpointAt : fileCkAt;
      const existing = outcomeLookup.get(key);
      if (!existing || ckAt >= existing.checkpointAt) {
        const pct = typeof c.pctChangeFromEntry === 'number' ? c.pctChangeFromEntry : null;
        const mul = typeof c.multipleFromEntry  === 'number' ? c.multipleFromEntry  : null;
        outcomeLookup.set(key, { pctChangeFromEntry: pct, multipleFromEntry: mul, checkpointAt: ckAt });
      }
    }
  }

  // ── Evaluate each rule ────────────────────────────────────────────────────

  const rules: RuleResult[] = SIM_RULES.map(rule => {
    const selected = candidates.filter(c => rule.test(c));

    const clusterBreakdown = { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 };
    for (const c of selected) {
      const k = c.clusterRisk as keyof typeof clusterBreakdown;
      if (k in clusterBreakdown) clusterBreakdown[k]++;
      else clusterBreakdown.UNKNOWN++;
    }

    const matchedOutcomes = selected
      .map(c => outcomeLookup.get(c.contractKey))
      .filter((o): o is OutcomeEntry => o != null);

    const matchedPcts   = matchedOutcomes.map(o => o.pctChangeFromEntry);
    const pctWithValues = matchedPcts.filter((p): p is number => p != null);

    return {
      ruleName:             rule.name,
      ruleDescription:      rule.description,
      selectedCount:        selected.length,
      avgScore:             avgOf(selected.map(c => c.score)),
      avgAge:               avgOf(selected.map(c => c.ageMinutes)),
      avgEntryPrice:        avgOf(selected.map(c => c.entryPriceUsd)),
      clusterBreakdown,
      matchedOutcomeCount:  pctWithValues.length,
      avgOutcomePctChange:  avgOf(matchedPcts),
      winnersCount:         pctWithValues.filter(p => p > 0).length,
      losersCount:          pctWithValues.filter(p => p <= 0).length,
    };
  });

  return {
    generatedAt,
    cycleFilesRead,
    cycleFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    fixturesScanned,
    uniqueApprovedCandidates: candidates.length,
    outcomeLookupSize:        outcomeLookup.size,
    rules,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtNum(n: number | null | undefined, decimals = 1): string {
  return n != null ? n.toFixed(decimals) : 'n/a';
}

function fmtAge(m: number | null | undefined): string {
  if (m == null) return 'n/a';
  return m < 60 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
}

function fmtPrice(p: number | null | undefined): string {
  return p != null ? `$${p.toFixed(8)}` : 'n/a';
}

export function renderRipperEntrySim(result: RipperEntrySimResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER DELAYED-ENTRY SIMULATION');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — NO LIVE API CALLS]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated         : ${result.generatedAt}`);
  lines.push(
    `  Cycle files read  : ${result.cycleFilesRead}` +
    (result.cycleFilesMissing > 0 ? `  (${result.cycleFilesMissing} missing)` : ''),
  );
  lines.push(`  Fixtures scanned  : ${result.fixturesScanned}`);
  lines.push(`  Unique approved   : ${result.uniqueApprovedCandidates}`);
  if (result.outcomeFilesRead > 0 || result.outcomeFilesMissing > 0) {
    lines.push(
      `  Outcome files     : ${result.outcomeFilesRead}` +
      (result.outcomeFilesMissing > 0 ? `  (${result.outcomeFilesMissing} missing)` : '') +
      `  |  lookup: ${result.outcomeLookupSize} contracts`,
    );
  }
  lines.push('');

  if (result.uniqueApprovedCandidates === 0) {
    lines.push('  (no approved candidates found in input files)');
    lines.push('');
  } else {
    const hasOutcomes = result.outcomeLookupSize > 0;

    for (let i = 0; i < result.rules.length; i++) {
      const r = result.rules[i];
      const clust = r.clusterBreakdown;

      lines.push(
        `  Rule ${(i + 1).toString().padStart(2)}: ${r.ruleName.padEnd(22)} — ${r.ruleDescription}`,
      );
      lines.push(
        `    Selected: ${r.selectedCount.toString().padStart(3)}` +
        `  |  Avg score: ${fmtNum(r.avgScore, 0).padStart(4)}` +
        `  |  Avg age: ${fmtAge(r.avgAge).padStart(6)}` +
        `  |  Avg entry: ${fmtPrice(r.avgEntryPrice)}`,
      );
      lines.push(
        `    Cluster: CLEAN=${clust.CLEAN} WATCH=${clust.WATCH} RISKY=${clust.RISKY} UNKNOWN=${clust.UNKNOWN}`,
      );
      if (hasOutcomes) {
        if (r.matchedOutcomeCount > 0) {
          lines.push(
            `    Outcomes: ${r.matchedOutcomeCount} matched` +
            `  |  Avg pctChange: ${fmtPct(r.avgOutcomePctChange)}` +
            `  |  Winners: ${r.winnersCount}  Losers: ${r.losersCount}`,
          );
        } else {
          lines.push(`    Outcomes: 0 matched`);
        }
      }
      lines.push('');
    }
  }

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}
