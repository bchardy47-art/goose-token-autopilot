import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runShadowFilterCandidateComparison,
  renderShadowFilterCandidateComparison,
} from '../src/token-grab/ripperShadowFilterCandidateComparison';

const BASE_MS  = 1_750_000_000_000;
const BASE_ISO = new Date(BASE_MS).toISOString();

function at(offsetMs: number): string { return new Date(BASE_MS + offsetMs).toISOString(); }

const CA = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CB = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CC = 'ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfcc-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ── Fixtures ──────────────────────────────────────────────────────────────────

function writeEnrollments(rows: object[], name = 'enrollments.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function writeObs(rows: object[], name = 'obs.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function writePaperIntents(rows: object[], name = 'paper-intents.jsonl'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

interface EnrollOpts {
  contract?:       string;
  capturedAt?:     string;
  cycleFile?:      string;
  buyGateDecision?: string;
  ripperScore?:    number;
  clusterRisk?:    string;
  launchAgeBucket?: string;
  ageMinutes?:     number;
  liquidityUsd?:   number;
  age_gte10m?:     boolean;
  liq_lt10k?:      boolean;
}

function makeEnrollment(opts: EnrollOpts = {}): object {
  const age_gte10m = opts.age_gte10m ?? false;
  const liq_lt10k  = opts.liq_lt10k  ?? false;
  const liq_OR_age = age_gte10m || liq_lt10k;
  return {
    capturedAt:      opts.capturedAt      ?? BASE_ISO,
    cycleFile:       opts.cycleFile       ?? 'cycle-2026-06-15-000000.jsonl',
    contract:        opts.contract        ?? CA,
    symbol:          'TOK',
    buyGateDecision: opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    ripperScore:     opts.ripperScore     ?? 100,
    clusterRisk:     opts.clusterRisk     ?? 'CLEAN',
    launchAgeBucket: opts.launchAgeBucket ?? 'PRIME_WINDOW',
    ageMinutes:      opts.ageMinutes      ?? 3,
    liquidityUsd:    opts.liquidityUsd    ?? 20_000,
    shadowRejectFlags: { age_gte10m, liq_lt10k, liq_OR_age },
    wouldRejectByBestCombo: liq_OR_age,
    actualDecisionPreserved: true,
    reportOnly: true, readOnly: true, paperOnly: true,
    realTradingLocked: true, tradingExecuted: 0,
  };
}

function makeObs(contract: string, capturedAt: string, priceChangePct: number | null): object {
  return {
    capturedAt,
    normalizedSignal: { contract, priceChangePct, id: 'o', source: 'test', sourceKind: 'x',
                        discoveredAt: BASE_ISO, warnings: [] },
    raw: { contract },
  };
}

// Build N enrollment rows and N obs rows for a given contract set.
// Each row gets a unique contract address and unique capturedAt.
function makeN(
  n: number,
  opts: EnrollOpts,
  priceChangePct: number,
  baseContract = 'C',
): { enrollments: object[]; obs: object[] } {
  const enrollments: object[] = [];
  const obsRows: object[] = [];
  for (let i = 0; i < n; i++) {
    const contract = `${baseContract}${String(i).padStart(43, '0')}`.slice(-44);
    const cap      = at(i * 1000);
    const obsAt    = at(i * 1000 + 60_000); // 1 minute after capture
    enrollments.push(makeEnrollment({ ...opts, contract, capturedAt: cap }));
    obsRows.push(makeObs(contract, obsAt, priceChangePct));
  }
  return { enrollments, obs: obsRows };
}

// ── Safety guards ─────────────────────────────────────────────────────────────

describe('safety — source file must not contain forbidden calls', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/token-grab/ripperShadowFilterCandidateComparison.ts'),
    'utf-8',
  );

  it('does NOT contain token:auto-paper', () => {
    expect(src).not.toContain('token:auto-paper');
  });

  it('does NOT contain token:paper-buy', () => {
    expect(src).not.toContain('token:paper-buy');
  });

  it('does NOT contain realTrading = true or enable real trading', () => {
    expect(src).not.toMatch(/realTrading\s*=\s*(?!true\b)[\w"']/);
    expect(src).not.toContain('enableRealTrading');
  });

  it('does NOT import paper decision policy or production gate modules', () => {
    expect(src).not.toContain('ripperPaperDecisionPolicy');
    expect(src).not.toContain('ripperBuyGate');
    expect(src).not.toContain('ripperAutopilot');
  });

  it('contains DO_NOT_ENABLE_REAL_TRADING banner', () => {
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('contains reportOnly=true and readOnly=true safety constants', () => {
    expect(src).toContain('reportOnly');
    expect(src).toContain('readOnly');
    expect(src).toContain('tradingExecuted');
  });
});

// ── Renderer safety banners ───────────────────────────────────────────────────

describe('renderShadowFilterCandidateComparison — safety banners', () => {
  it('includes REPORT ONLY banner', () => {
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  writeEnrollments([]),
      observationPaths: [],
    });
    const text = renderShadowFilterCandidateComparison(result);
    expect(text).toContain('REPORT ONLY');
    expect(text).toContain('NO TRADES');
    expect(text).toContain('DO NOT ENABLE REAL TRADING');
  });

  it('includes DO NOT CHANGE PRODUCTION GATES warning', () => {
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  writeEnrollments([]),
      observationPaths: [],
    });
    const text = renderShadowFilterCandidateComparison(result);
    expect(text).toContain('DO NOT CHANGE PRODUCTION GATES');
  });

  it('includes DO NOT WIRE INTO AUTOPILOT DECISIONS warning', () => {
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  writeEnrollments([]),
      observationPaths: [],
    });
    const text = renderShadowFilterCandidateComparison(result);
    expect(text).toContain('DO NOT WIRE INTO AUTOPILOT DECISIONS');
  });

  it('result object has all safety fields set correctly', () => {
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  writeEnrollments([]),
      observationPaths: [],
    });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── Only enrolled approved rows are included ──────────────────────────────────

describe('runShadowFilterCandidateComparison — only enrolled approved rows', () => {
  it('excludes rows with buyGateDecision != BUY_APPROVED_PAPER', () => {
    const enrollments = writeEnrollments([
      makeEnrollment({ contract: CA, buyGateDecision: 'BUY_APPROVED_PAPER', liq_lt10k: true }),
      makeEnrollment({ contract: CB, buyGateDecision: 'BUY_REJECTED',       liq_lt10k: true }),
    ]);
    const obsPath = writeObs([
      makeObs(CA, at(10_000), 10),  // big winner
      makeObs(CB, at(10_000), 10),  // big winner — should be excluded
    ]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollments,
      observationPaths: [obsPath],
    });
    // Only CA should be in universe (1 enrolled, not CB which was rejected)
    expect(result.enrollmentsRead).toBe(1);
    const liqCandidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(liqCandidate.enrolledCount).toBe(1);
  });

  it('deduplicates rows by contract+capturedAt', () => {
    const row = makeEnrollment({ contract: CA, liq_lt10k: true });
    const enrollments = writeEnrollments([row, row, row]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollments,
      observationPaths: [],
    });
    expect(result.enrollmentsRead).toBe(1);
  });
});

// ── NEEDS_MORE_DATA when observed count is low ────────────────────────────────

describe('runShadowFilterCandidateComparison — NEEDS_MORE_DATA', () => {
  it('returns NEEDS_MORE_DATA for age_gte10m with fewer than 50 observed', () => {
    const { enrollments: rows, obs } = makeN(30, { age_gte10m: true }, 0.2);
    const enrollPath = writeEnrollments(rows);
    const obsPath    = writeObs(obs);
    const result     = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [obsPath],
    });
    const ageCandidate = result.candidates.find(c => c.candidateName === 'age_gte10m')!;
    expect(ageCandidate.observedCount).toBe(30);
    expect(ageCandidate.recommendation).toBe('NEEDS_MORE_DATA');
  });

  it('returns NEEDS_MORE_DATA for liq_OR_age when no enrollments at all', () => {
    const enrollPath = writeEnrollments([]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const candidate = result.candidates.find(c => c.candidateName === 'liq_OR_age')!;
    expect(candidate.recommendation).toBe('NEEDS_MORE_DATA');
  });
});

// ── NO_CLEAR_EDGE when winner rate is too high ────────────────────────────────

describe('runShadowFilterCandidateComparison — NO_CLEAR_EDGE', () => {
  it('returns NO_CLEAR_EDGE when win1Rate > 5%', () => {
    // 50 rows blocked, 6 of them are winners (12%) → NO_CLEAR_EDGE
    const { enrollments: junk, obs: junkObs } = makeN(44, { liq_lt10k: true }, 0.2, 'J');
    const { enrollments: win, obs: winObs }   = makeN(6,  { liq_lt10k: true }, 5.5, 'W');
    const enrollPath = writeEnrollments([...junk, ...win]);
    const obsPath    = writeObs([...junkObs, ...winObs]);
    const result     = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [obsPath],
    });
    const liqCandidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(liqCandidate.observedCount).toBeGreaterThanOrEqual(50);
    expect(liqCandidate.win1Rate!).toBeGreaterThan(5);
    expect(liqCandidate.recommendation).toBe('NO_CLEAR_EDGE');
  });

  it('returns NO_CLEAR_EDGE when control/blocked multiple < 3', () => {
    // blocked: 50 observed, 2 winners (4% win1) — meets win1 threshold
    // control: 50 observed, 4 winners (8% win1) — multiple = 2x < 3 → NO_CLEAR_EDGE
    const { enrollments: blocked, obs: blockedObs } = makeN(48, { liq_lt10k: true }, 0.2, 'B');
    const { enrollments: bwin, obs: bwinObs }       = makeN(2,  { liq_lt10k: true }, 5.5, 'V');
    const { enrollments: ctrl, obs: ctrlObs }       = makeN(46, { liq_lt10k: false }, 0.2, 'K');
    const { enrollments: cwin, obs: cwinObs }       = makeN(4,  { liq_lt10k: false }, 5.5, 'L');

    const enrollPath = writeEnrollments([...blocked, ...bwin, ...ctrl, ...cwin]);
    const obsPath    = writeObs([...blockedObs, ...bwinObs, ...ctrlObs, ...cwinObs]);
    const result     = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [obsPath],
    });
    const liqCandidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(liqCandidate.controlVsBlockedMultiple).not.toBeNull();
    expect(liqCandidate.controlVsBlockedMultiple!).toBeLessThan(3);
    expect(liqCandidate.recommendation).toBe('NO_CLEAR_EDGE');
  });
});

// ── PROMISING_SHADOW_FILTER ───────────────────────────────────────────────────

describe('runShadowFilterCandidateComparison — PROMISING_SHADOW_FILTER', () => {
  it('returns PROMISING when all thresholds met (0 blocked winners, strong control)', () => {
    // blocked: 55 flat junk (no winners)
    // control: 20 observed, 8 winners (40%) → multiple = n/a but win1Count=0 → trivially OK
    const { enrollments: blocked, obs: blockedObs } = makeN(55, { liq_lt10k: true }, 0.2, 'B');
    const { enrollments: ctrl, obs: ctrlObs }       = makeN(16, { liq_lt10k: false }, 0.2, 'K');
    const { enrollments: cwin, obs: cwinObs }       = makeN(4,  { liq_lt10k: false }, 5.5, 'L');

    const enrollPath = writeEnrollments([...blocked, ...ctrl, ...cwin]);
    const obsPath    = writeObs([...blockedObs, ...ctrlObs, ...cwinObs]);
    const result     = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [obsPath],
    });
    const liqCandidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(liqCandidate.win1Count).toBe(0);
    expect(liqCandidate.win1Rate).toBe(0);
    expect(liqCandidate.recommendation).toBe('PROMISING_SHADOW_FILTER');
  });

  it('returns PROMISING with few winners when control multiple >= 3', () => {
    // blocked: 49 flat + 1 winner (5.5%) = 50 observed
    //   win1=2%, win3=2%, win5=2% — all ≤ their thresholds
    // control: 24 flat + 6 winners = 30 observed, win1=20% → multiple=10x ≥ 3
    const { enrollments: bflat, obs: bflatObs } = makeN(49, { liq_lt10k: true }, 0.2, 'F');
    const { enrollments: bwin,  obs: bwinObs }  = makeN(1,  { liq_lt10k: true }, 5.5, 'W');
    const { enrollments: cflat, obs: cflatObs } = makeN(24, { liq_lt10k: false }, 0.2, 'P');
    const { enrollments: cwin,  obs: cwinObs }  = makeN(6,  { liq_lt10k: false }, 5.5, 'Q');

    const enrollPath = writeEnrollments([...bflat, ...bwin, ...cflat, ...cwin]);
    const obsPath    = writeObs([...bflatObs, ...bwinObs, ...cflatObs, ...cwinObs]);
    const result     = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [obsPath],
    });
    const liqCandidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(liqCandidate.win1Rate).toBeLessThanOrEqual(5);
    expect(liqCandidate.win3Rate).toBeLessThanOrEqual(3);
    expect(liqCandidate.win5Rate).toBeLessThanOrEqual(2);
    expect(liqCandidate.controlVsBlockedMultiple).not.toBeNull();
    expect(liqCandidate.controlVsBlockedMultiple!).toBeGreaterThanOrEqual(3);
    expect(liqCandidate.recommendation).toBe('PROMISING_SHADOW_FILTER');
  });
});

// ── age_gte10m vs liq_OR_age comparison ──────────────────────────────────────

describe('runShadowFilterCandidateComparison — age vs liq_OR_age comparison', () => {
  it('age_gte10m can have lower win1Rate than liq_OR_age when liq rows are winners', () => {
    // age-only rows: age_gte10m=true, liq_lt10k=false — all flat junk
    const { enrollments: ageOnly, obs: ageObs } = makeN(
      50, { age_gte10m: true, liq_lt10k: false }, 0.2, 'A',
    );
    // liq-only rows: age_gte10m=false, liq_lt10k=true — big winners (not age-blocked)
    const { enrollments: liqOnly, obs: liqObs } = makeN(
      50, { age_gte10m: false, liq_lt10k: true }, 10, 'L',
    );
    // control rows: neither blocked
    const { enrollments: ctrl, obs: ctrlObs } = makeN(
      50, { age_gte10m: false, liq_lt10k: false }, 3.5, 'C',
    );

    const enrollPath = writeEnrollments([...ageOnly, ...liqOnly, ...ctrl]);
    const obsPath    = writeObs([...ageObs, ...liqObs, ...ctrlObs]);
    const result     = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [obsPath],
    });

    const ageCandidate    = result.candidates.find(c => c.candidateName === 'age_gte10m')!;
    const liqOrAgeCandidate = result.candidates.find(c => c.candidateName === 'liq_OR_age')!;

    // age_gte10m only sees the age-only rows (all flat) → win1=0%
    expect(ageCandidate.win1Rate).toBe(0);
    // liq_OR_age sees both age and liq rows (50 flat + 50 winners) → win1=50%
    expect(liqOrAgeCandidate.win1Rate!).toBeGreaterThan(40);

    // So age_gte10m has strictly lower win1Rate than liq_OR_age
    expect(ageCandidate.win1Rate!).toBeLessThan(liqOrAgeCandidate.win1Rate!);
  });

  it('age_gte10m enrolled count is subset of liq_OR_age enrolled count', () => {
    const { enrollments: ageOnly } = makeN(20, { age_gte10m: true,  liq_lt10k: false }, 0.2, 'A');
    const { enrollments: liqOnly } = makeN(15, { age_gte10m: false, liq_lt10k: true  }, 0.2, 'L');
    const { enrollments: both }    = makeN(10, { age_gte10m: true,  liq_lt10k: true  }, 0.2, 'X');
    const enrollPath = writeEnrollments([...ageOnly, ...liqOnly, ...both]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const ageCandidate    = result.candidates.find(c => c.candidateName === 'age_gte10m')!;
    const liqCandidate    = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    const liqOrAgeCandidate = result.candidates.find(c => c.candidateName === 'liq_OR_age')!;

    expect(ageCandidate.enrolledCount).toBe(30);      // ageOnly + both
    expect(liqCandidate.enrolledCount).toBe(25);      // liqOnly + both
    expect(liqOrAgeCandidate.enrolledCount).toBe(45); // all three groups
  });
});

// ── Filter predicate logic ────────────────────────────────────────────────────

describe('runShadowFilterCandidateComparison — filter predicates', () => {
  it('liq_lt10k_AND_not_clean_score100_prime excludes CLEAN+100+PRIME rows', () => {
    const cleanPrime = makeEnrollment({
      contract: CA, liq_lt10k: true,
      clusterRisk: 'CLEAN', ripperScore: 100, launchAgeBucket: 'PRIME_WINDOW',
    });
    const notPrime = makeEnrollment({
      contract: CB, liq_lt10k: true,
      clusterRisk: 'CLEAN', ripperScore: 100, launchAgeBucket: 'LAUNCH_WINDOW',
    });
    const enrollPath = writeEnrollments([cleanPrime, notPrime]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const c = result.candidates.find(c => c.candidateName === 'liq_lt10k_AND_not_clean_score100_prime')!;
    // cleanPrime is excluded (kept), only notPrime is rejected
    expect(c.enrolledCount).toBe(1);
  });

  it('liq_OR_age_BUT_keep_score100 excludes ripperScore=100 rows', () => {
    const score100 = makeEnrollment({ contract: CA, liq_lt10k: true, ripperScore: 100 });
    const score90  = makeEnrollment({ contract: CB, liq_lt10k: true, ripperScore: 90  });
    const enrollPath = writeEnrollments([score100, score90]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const c = result.candidates.find(c => c.candidateName === 'liq_OR_age_BUT_keep_score100')!;
    // score100 is kept (not rejected), score90 is rejected
    expect(c.enrolledCount).toBe(1);
  });

  it('liq_OR_age_BUT_keep_liq_10k_plus is effectively liq_lt10k', () => {
    // row with liq=15k and age_gte10m=true: liq_OR_age=true but liq >= 10k → NOT rejected by this filter
    const highLiq = makeEnrollment({
      contract: CA, age_gte10m: true, liq_lt10k: false, liquidityUsd: 15_000,
    });
    // row with liq=5k: liq_lt10k=true → rejected by both liq_lt10k and liq_OR_age_BUT_keep_liq_10k_plus
    const lowLiq = makeEnrollment({
      contract: CB, age_gte10m: false, liq_lt10k: true, liquidityUsd: 5_000,
    });
    const enrollPath = writeEnrollments([highLiq, lowLiq]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const keepLiq = result.candidates.find(c => c.candidateName === 'liq_OR_age_BUT_keep_liq_10k_plus')!;
    const liqLt10k = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    // Both should reject only the low-liq row
    expect(keepLiq.enrolledCount).toBe(1);
    expect(liqLt10k.enrolledCount).toBe(1);
  });
});

// ── Observation timing — targetEntryAt floor ──────────────────────────────────

describe('runShadowFilterCandidateComparison — observation timing', () => {
  it('uses targetEntryAt from paper-intents as obs floor when available', () => {
    // capturedAt = BASE_ISO, targetEntryAt = BASE_ISO + 10 min
    // obs at BASE_ISO + 5 min → before targetEntryAt → UNOBSERVED
    // obs at BASE_ISO + 15 min → after targetEntryAt → observed
    const cycleFile = 'cycle-2026-06-15-000000.jsonl';
    const cycleId   = 'cycle-2026-06-15-000000';
    const capAt     = BASE_ISO;
    const targetAt  = at(10 * 60_000);  // +10min
    const earlyObs  = at(5 * 60_000);   // +5min  — before target
    const lateObs   = at(15 * 60_000);  // +15min — after target

    const enrollPath  = writeEnrollments([
      makeEnrollment({ contract: CA, capturedAt: capAt, cycleFile, liq_lt10k: true }),
    ]);
    const intentsPath = writePaperIntents([
      { contract: CA, sourceCycle: cycleId, targetEntryAt: targetAt,
        paperEntryTiming: 'WAIT_10M', realTradingLocked: true, paperOnly: true, tradingExecuted: 0 },
    ]);
    const obsPath = writeObs([
      makeObs(CA, earlyObs, 50),   // would be observed if floor = capturedAt
      makeObs(CA, lateObs, 0.2),   // observed after targetEntryAt
    ]);

    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      paperIntentsPath: intentsPath,
      observationPaths: [obsPath],
    });

    // With targetEntryAt floor, early obs is skipped → late obs (FLAT_JUNK) is matched
    const candidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(candidate.observedCount).toBe(1);
    expect(candidate.win5Count).toBe(0);  // the 50% obs was skipped
    expect(candidate.flatJunkCount).toBe(1);  // the 0.2% obs was matched
  });

  it('falls back to capturedAt when no paper intent exists', () => {
    const capAt  = BASE_ISO;
    const obsAt  = at(5 * 60_000);  // +5min after capture

    const enrollPath  = writeEnrollments([
      makeEnrollment({ contract: CA, capturedAt: capAt, liq_lt10k: true }),
    ]);
    // No paper intents file → fall back to capturedAt
    const intentsPath = writePaperIntents([]);
    const obsPath = writeObs([
      makeObs(CA, obsAt, 7.0),  // WIN_5PCT after capture
    ]);

    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      paperIntentsPath: intentsPath,
      observationPaths: [obsPath],
    });
    const candidate = result.candidates.find(c => c.candidateName === 'liq_lt10k')!;
    expect(candidate.observedCount).toBe(1);
    expect(candidate.win5Count).toBe(1);
  });
});

// ── Result structure ──────────────────────────────────────────────────────────

describe('runShadowFilterCandidateComparison — result structure', () => {
  it('returns exactly 8 filter candidates', () => {
    const enrollPath = writeEnrollments([]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    expect(result.candidates).toHaveLength(8);
  });

  it('candidate names match expected set', () => {
    const enrollPath = writeEnrollments([]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const names = result.candidates.map(c => c.candidateName);
    expect(names).toContain('age_gte10m');
    expect(names).toContain('liq_lt10k');
    expect(names).toContain('liq_OR_age');
    expect(names).toContain('liq_lt10k_AND_not_clean_score100_prime');
    expect(names).toContain('liq_lt10k_AND_not_score100');
    expect(names).toContain('liq_OR_age_BUT_keep_clean_score100_prime');
    expect(names).toContain('liq_OR_age_BUT_keep_score100');
    expect(names).toContain('liq_OR_age_BUT_keep_liq_10k_plus');
  });

  it('renders SIDE-BY-SIDE SUMMARY TABLE', () => {
    const enrollPath = writeEnrollments([]);
    const result = runShadowFilterCandidateComparison({
      enrollmentsPath:  enrollPath,
      observationPaths: [],
    });
    const text = renderShadowFilterCandidateComparison(result);
    expect(text).toContain('SIDE-BY-SIDE SUMMARY TABLE');
    expect(text).toContain('age_gte10m');
    expect(text).toContain('liq_lt10k');
    expect(text).toContain('liq_OR_age');
  });
});

// ── Package.json registration ─────────────────────────────────────────────────

describe('package.json — script registration', () => {
  it('registers token:ripper-shadow-filter-candidate-comparison', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['token:ripper-shadow-filter-candidate-comparison']).toBeDefined();
    expect(scripts['token:ripper-shadow-filter-candidate-comparison']).toContain(
      'token:ripper-shadow-filter-candidate-comparison',
    );
  });
});
