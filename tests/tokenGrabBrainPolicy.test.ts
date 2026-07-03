import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  refreshBrainPolicy,
  buildPolicyMemory,
  policyProfileKey,
  policyStatus,
  globalPolicyStatus,
  globalGroupsForParts,
  resolveBrainDecision,
  applyKillHysteresis,
  isRecovered,
  KILL_HYSTERESIS,
  confidenceTier,
  resolvePolicyStatus,
  renderBrainRefreshReport,
  loadBrainPolicyMemory,
  DEFAULT_BRAIN_POLICY_MEMORY_PATH,
  type BrainPolicyMemory,
  type PolicyProfileParts,
  type PolicyStatus,
} from '../src/token-grab/brainPolicy';
import { recordResearchShadow } from '../src/token-grab/researchShadow';
import { resolveLiveShadowSource, primaryLane, type ShadowCandidate } from '../src/token-grab/liveShadow';

const NOW_MS = new Date('2026-07-01T12:00:00Z').getTime();
const ISO = new Date(NOW_MS).toISOString();

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

// ── Synthetic research-shadow event builders ──────────────────────────────────────────────────

const BASE_PROFILE: PolicyProfileParts = {
  lane: 'NO_BM_INTERNAL_BROAD', productionGateApproved: false, launchAgeBucket: 'PRIME_WINDOW',
  m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2', ripperScoreBand: 'BAND_60_80',
};

function buyEvent(profile: PolicyProfileParts, contract: string, sourceCycle: string) {
  return {
    type: 'RESEARCH_WOULD_BUY', ts: ISO, contract, symbol: contract.slice(0, 4),
    lane: profile.lane, m5Band: profile.m5Band, liquidityBucket: profile.liquidityBucket, vlrBucket: profile.vlrBucket,
    ripperScoreBand: profile.ripperScoreBand, ripperScore: 70, productionGateApproved: profile.productionGateApproved,
    clusterRisk: 'UNKNOWN', sourceCycle, entryValuation: 0.001, valuationField: 'priceUsd',
    entryMomentumPct: -10, entryLiquidityChangePct: 10, entryVlr: 0.6, launchAgeBucket: profile.launchAgeBucket,
    paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, notBuySignal: true,
  };
}

function sellEvent(profile: PolicyProfileParts, contract: string, sourceCycle: string, usable: boolean, pnlPct: number | null) {
  return {
    type: 'RESEARCH_WOULD_SELL', ts: ISO, contract, symbol: contract.slice(0, 4),
    lane: profile.lane, sourceCycle, exitReason: usable ? 'MAX_HOLD_TIME' : 'DATA_STALE_EXIT', note: 'test',
    entryValuation: 0.001, exitValuation: usable ? 0.0015 : null, valuationField: 'priceUsd',
    valuationUsable: usable, valuationStatus: usable ? 'OK' : 'VALUATION_UNAVAILABLE',
    valuationMissing: usable ? [] : ['contractNotInLatestCycle'],
    pnlPct: usable ? pnlPct : null, pnlUsd: usable && pnlPct != null ? pnlPct / 100 : null, holdMinutes: 35,
    productionGateApproved: profile.productionGateApproved, launchAgeBucket: profile.launchAgeBucket,
    m5Band: profile.m5Band, liquidityBucket: profile.liquidityBucket, vlrBucket: profile.vlrBucket, ripperScoreBand: profile.ripperScoreBand,
    notBuySignal: true, paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
}

/** Emit buy+sell pairs for one profile: `valuedPnls` valued, plus `unvalued` VALUATION_UNAVAILABLE. */
function profileEvents(profile: PolicyProfileParts, tag: string, valuedPnls: number[], unvalued = 0): any[] {
  const out: any[] = [];
  let i = 0;
  for (const pnl of valuedPnls) {
    const contract = `${tag}V${i}${'z'.repeat(40)}`.slice(0, 43);
    const cyc = `cycle-${tag}-${i}`;
    out.push(buyEvent(profile, contract, cyc), sellEvent(profile, contract, cyc, true, pnl));
    i++;
  }
  for (let u = 0; u < unvalued; u++) {
    const contract = `${tag}U${u}${'z'.repeat(40)}`.slice(0, 43);
    const cyc = `cycle-${tag}-u${u}`;
    out.push(buyEvent(profile, contract, cyc), sellEvent(profile, contract, cyc, false, null));
    i++;
  }
  return out;
}

function writeEvents(events: any[]): string {
  const dir = tmpDir();
  const p = path.join(dir, 'research-shadow-events.jsonl');
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return p;
}

// pnl helpers to hit specific rates
const losers  = (n: number) => Array.from({ length: n }, () => -20);
const winners = (n: number) => Array.from({ length: n }, () => 30);

// ── Pure status/tier rules ──────────────────────────────────────────────────────────────────

describe('policyStatus + confidenceTier rules', () => {
  it('valued < 10 → TOO_SMALL tier and WATCH status', () => {
    expect(confidenceTier(5)).toBe('TOO_SMALL');
    expect(policyStatus({ valuedClosed: 5, medianPnlPct: -50, cappedAveragePnlPct: -50, redLossRate: 1 })).toBe('WATCH');
  });
  it('redLossRate >= 75% with valued >= 10 → KILL', () => {
    expect(policyStatus({ valuedClosed: 12, medianPnlPct: -10, cappedAveragePnlPct: -10, redLossRate: 0.83 })).toBe('KILL');
  });
  it('median<0 & cappedAvg<0 & redLoss in [60%,75%) with valued>=10 → DEMOTE', () => {
    expect(policyStatus({ valuedClosed: 10, medianPnlPct: -5, cappedAveragePnlPct: -11, redLossRate: 0.7 })).toBe('DEMOTE');
  });
  it('median>0 & cappedAvg>0 & redLoss<=45% with valued>=20 → PROMOTE', () => {
    expect(policyStatus({ valuedClosed: 20, medianPnlPct: 8, cappedAveragePnlPct: 18, redLossRate: 0.3 })).toBe('PROMOTE');
    expect(confidenceTier(20)).toBe('STRONG');
  });
  it('winning but only 15 valued (< promote min 20) stays WATCH', () => {
    expect(policyStatus({ valuedClosed: 15, medianPnlPct: 8, cappedAveragePnlPct: 18, redLossRate: 0.3 })).toBe('WATCH');
    expect(confidenceTier(15)).toBe('WATCH');
  });
});

// ── Build + refresh ──────────────────────────────────────────────────────────────────────────

describe('refreshBrainPolicy — creates and populates policy-memory.json', () => {
  it('creates policy-memory.json with profiles + safety flags', () => {
    const eventsPath = writeEvents(profileEvents(BASE_PROFILE, 'base', winners(20)));
    const memoryPath = path.join(path.dirname(eventsPath), 'brain', 'policy-memory.json');

    const res = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: ISO });

    expect(fs.existsSync(memoryPath)).toBe(true);
    const mem = JSON.parse(fs.readFileSync(memoryPath, 'utf-8')) as BrainPolicyMemory;
    expect(mem.totalProfiles).toBe(1);
    expect(mem.readyForRealTrading).toBe(false);
    expect(mem.realTrading).toBe(false);
    expect(mem.noWallet).toBe(true);
    expect(mem.noSwap).toBe(true);
    expect(mem.noSigning).toBe(true);
    expect(mem.unknownStaysUnknown).toBe(true);
    expect(res.previousExisted).toBe(false);
    expect(res.changes.every(c => c.kind === 'NEW')).toBe(true);
  });

  it('a losing profile becomes DEMOTE or KILL', () => {
    // 11 losers + 1 winner over 12 valued → redLoss 11/12 = 91.7% → KILL.
    const killEvents = profileEvents({ ...BASE_PROFILE, m5Band: 'kill' }, 'kill', [...losers(11), 30]);
    // 7 losers + 3 winners over 10 valued → redLoss 70%, median<0, cappedAvg<0 → DEMOTE.
    const demoteEvents = profileEvents({ ...BASE_PROFILE, m5Band: 'demote' }, 'demo', [...losers(7), ...winners(3)]);
    const eventsPath = writeEvents([...killEvents, ...demoteEvents]);
    const memoryPath = path.join(path.dirname(eventsPath), 'policy-memory.json');

    const res = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: ISO });

    const kill = res.memory.profiles[policyProfileKey({ ...BASE_PROFILE, m5Band: 'kill' })];
    const demote = res.memory.profiles[policyProfileKey({ ...BASE_PROFILE, m5Band: 'demote' })];
    expect(kill.policyStatus).toBe('KILL');
    expect(demote.policyStatus).toBe('DEMOTE');
    expect(res.killed.map(p => p.policyStatus)).toContain('KILL');
    expect(res.demoted.map(p => p.policyStatus)).toContain('DEMOTE');
  });

  it('a winning profile becomes PROMOTE', () => {
    const eventsPath = writeEvents(profileEvents(BASE_PROFILE, 'win', [...winners(14), ...losers(6)]));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'mem.json'), generatedAt: ISO });
    const prof = res.memory.profiles[policyProfileKey(BASE_PROFILE)];
    expect(prof.policyStatus).toBe('PROMOTE');
    expect(prof.confidenceTier).toBe('STRONG');
    expect(res.promoted).toHaveLength(1);
  });

  it('a too-small profile stays WATCH / TOO_SMALL', () => {
    const eventsPath = writeEvents(profileEvents(BASE_PROFILE, 'small', losers(5)));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'mem.json'), generatedAt: ISO });
    const prof = res.memory.profiles[policyProfileKey(BASE_PROFILE)];
    expect(prof.policyStatus).toBe('WATCH');
    expect(prof.confidenceTier).toBe('TOO_SMALL');
    expect(res.tooSmall).toHaveLength(1);
  });

  it('unavailable valuations are excluded from stats, never counted as flat', () => {
    // 3 valued winners + 5 VALUATION_UNAVAILABLE.
    const eventsPath = writeEvents(profileEvents(BASE_PROFILE, 'unval', winners(3), 5));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'mem.json'), generatedAt: ISO });
    const prof = res.memory.profiles[policyProfileKey(BASE_PROFILE)];
    expect(prof.valuedClosed).toBe(3);
    expect(prof.unvaluedClosed).toBe(5);
    expect(prof.flats).toBe(0);            // unvalued NOT treated as flat
    expect(prof.wins).toBe(3);
    expect(prof.losses).toBe(0);
    expect(prof.redLossRate).toBe(0);      // over valued only
  });

  it('reports what changed since the last refresh (status change)', () => {
    const memoryPath = path.join(tmpDir(), 'policy-memory.json');
    // First refresh: winning profile → PROMOTE.
    const p1 = writeEvents(profileEvents(BASE_PROFILE, 'chg', winners(20)));
    refreshBrainPolicy({ eventsPath: p1, memoryPath, generatedAt: ISO });
    // Second refresh: same profile now mostly losing → KILL.
    const p2 = writeEvents(profileEvents(BASE_PROFILE, 'chg', [...losers(11), 30]));
    const res2 = refreshBrainPolicy({ eventsPath: p2, memoryPath, generatedAt: ISO });
    expect(res2.previousExisted).toBe(true);
    const change = res2.changes.find(c => c.scope === 'EXACT' && c.kind === 'STATUS_CHANGE');
    expect(change).toBeTruthy();
    expect(change!.from).toBe('PROMOTE');
    expect(change!.to).toBe('KILL');
  });
});

// ── Integration with research-shadow ───────────────────────────────────────────────────────────

interface RowOpts { priceUsd?: number | null }
function cycleRow(contract: string, o: RowOpts = {}): Record<string, unknown> {
  const m5 = -10;
  const priceUsd = o.priceUsd === undefined ? 0.001 : o.priceUsd;
  const raw = priceUsd == null ? { contract } : { contract, entry: { contract, priceUsd }, final: { contract, priceUsd } };
  return {
    capturedAt: ISO, ripperScore: 70, launchAgeBucket: 'PRIME_WINDOW', buyGateDecision: 'BUY_APPROVED_PAPER',
    entryDecision: 'READY_TO_SNIPE_PAPER', entryMomentumPct: m5, topReasons: [`m ${m5}`],
    ripperInput: { contract, clusterRisk: 'UNKNOWN' }, raw,
    normalizedSignal: {
      contract, symbol: contract.slice(0, 4), liquidityUsd: 20_000, volumeLiquidityRatio: 0.6,
      priceChangePct: 35, liquidityChangePct: 10, entryPriceChangeM5: m5, observedAt: ISO,
    },
  };
}

function resolveCycle(rows: Record<string, unknown>[], slug: string): { candidates: ShadowCandidate[]; sourceCycle: string } {
  const dir = tmpDir();
  const cyclesDir = path.join(dir, 'cycles');
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.writeFileSync(path.join(cyclesDir, `cycle-${slug}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  const resolved = resolveLiveShadowSource({ cyclesDir, statePath: path.join(dir, 's.json'), eventsPath: path.join(dir, 'e.jsonl') }, NOW_MS);
  return { candidates: resolved.candidates, sourceCycle: resolved.sourceCycle };
}

function partsOf(c: ShadowCandidate): PolicyProfileParts {
  return {
    lane: primaryLane(c)!, productionGateApproved: c.productionGateApproved, launchAgeBucket: c.launchAgeBucket,
    m5Band: c.m5Band, liquidityBucket: c.liquidityBucket, vlrBucket: c.vlrBucket, ripperScoreBand: c.ripperScoreBand,
  };
}

function memoryWith(parts: PolicyProfileParts, status: PolicyStatus): BrainPolicyMemory {
  return {
    version: 1.1, generatedAt: ISO, eventsPath: 'x', totalProfiles: 1,
    profiles: {
      [policyProfileKey(parts)]: {
        ...parts, key: policyProfileKey(parts), sampleSize: 30, valuedClosed: 25, unvaluedClosed: 0,
        wins: status === 'PROMOTE' ? 20 : 5, losses: status === 'PROMOTE' ? 5 : 20, flats: 0,
        medianPnlPct: status === 'PROMOTE' ? 8 : -8, cappedAveragePnlPct: status === 'PROMOTE' ? 18 : -18,
        redLossRate: status === 'PROMOTE' ? 0.2 : 0.8, bestTrade: null, worstTrade: null,
        lastUpdated: ISO, confidenceTier: 'STRONG', policyStatus: status,
      },
    },
    totalGlobalGroups: 0, globalGroups: {},
    realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
    paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
  };
}

/** Build a memory whose GLOBAL group for one dimension slice has the given status (exact profiles empty). */
function memoryWithGlobal(parts: PolicyProfileParts, dimensionKey: string, status: import('../src/token-grab/brainPolicy').GlobalPolicyStatus, exactStatus?: PolicyStatus): BrainPolicyMemory {
  const winning = status === 'PROMOTE' || status === 'PROMOTE_LIGHT';
  const profiles: BrainPolicyMemory['profiles'] = {};
  if (exactStatus) {
    profiles[policyProfileKey(parts)] = {
      ...parts, key: policyProfileKey(parts), sampleSize: 30, valuedClosed: 25, unvaluedClosed: 0,
      wins: exactStatus === 'PROMOTE' ? 20 : 5, losses: exactStatus === 'PROMOTE' ? 5 : 20, flats: 0,
      medianPnlPct: exactStatus === 'PROMOTE' ? 8 : -8, cappedAveragePnlPct: exactStatus === 'PROMOTE' ? 18 : -18,
      redLossRate: exactStatus === 'PROMOTE' ? 0.2 : 0.8, bestTrade: null, worstTrade: null,
      lastUpdated: ISO, confidenceTier: 'STRONG', policyStatus: exactStatus,
    };
  }
  return {
    version: 1.1, generatedAt: ISO, eventsPath: 'x', totalProfiles: Object.keys(profiles).length,
    profiles,
    totalGlobalGroups: 1,
    globalGroups: {
      [dimensionKey]: {
        key: dimensionKey, dimension: dimensionKey.split(':')[0] as any, value: dimensionKey.split(':')[1],
        buys: 30, valuedClosed: 22, unvaluedClosed: 0,
        wins: winning ? 16 : 5, losses: winning ? 5 : 17, flats: 0,
        medianPnlPct: winning ? 6 : -8, cappedAveragePnlPct: winning ? 12 : -10,
        redLossRate: winning ? 0.23 : 0.77, bestTrade: null, worstTrade: null,
        lastUpdated: ISO, confidenceTier: 'STRONG', policyStatus: status,
      },
    },
    realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
    paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
  };
}

function readEvents(p: string): any[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const K1 = 'BrainKill111111111111111111111111111111111A';
const P1 = 'BrainProm111111111111111111111111111111111A';

describe('research-shadow honors brain policy', () => {
  it('skips KILL profiles — no research position opened, RESEARCH_SKIPPED_BY_BRAIN logged', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const statePath  = path.join(dir, 'state.json');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(K1)], '2026-07-01-115500');
    const memory = memoryWith(partsOf(candidates[0]), 'KILL');

    const res = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath, eventsPath, policyMemory: memory });

    expect(res.researchBuys).toBe(0);
    expect(res.skippedByBrain).toBe(1);
    expect(res.openPositions).toBe(0);
    const events = readEvents(eventsPath);
    expect(events.filter(e => e.type === 'RESEARCH_WOULD_BUY')).toHaveLength(0);
    const skip = events.find(e => e.type === 'RESEARCH_SKIPPED_BY_BRAIN');
    expect(skip).toBeTruthy();
    expect(skip.brainStatus).toBe('KILL');
    expect(skip.notBuySignal).toBe(true);
    expect(skip.realTrading).toBe(false);
  });

  it('DEMOTE profiles are recorded-as-skipped by default, but opened in observation mode', () => {
    const { candidates, sourceCycle } = resolveCycle([cycleRow(K1)], '2026-07-01-115500');
    const memory = memoryWith(partsOf(candidates[0]), 'DEMOTE');

    // Default: skip (do not open).
    const d1 = tmpDir();
    const res1 = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(d1, 's.json'), eventsPath: path.join(d1, 'e.jsonl'), policyMemory: memory });
    expect(res1.researchBuys).toBe(0);
    expect(res1.skippedByBrain).toBe(1);

    // Observation mode: open, labeled DEMOTE_OBSERVATION.
    const d2 = tmpDir();
    const res2 = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(d2, 's.json'), eventsPath: path.join(d2, 'e.jsonl'), policyMemory: memory, observationMode: true });
    expect(res2.researchBuys).toBe(1);
    const buy = readEvents(path.join(d2, 'e.jsonl')).find(e => e.type === 'RESEARCH_WOULD_BUY');
    expect(buy.brainAction).toBe('DEMOTE_OBSERVATION');
  });

  it('annotates PROMOTE profiles (brainAction=PROMOTE) and still opens the position', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(P1)], '2026-07-01-115500');
    const memory = memoryWith(partsOf(candidates[0]), 'PROMOTE');

    const res = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(dir, 'state.json'), eventsPath, policyMemory: memory });

    expect(res.researchBuys).toBe(1);
    expect(res.promotedByBrain).toBe(1);
    const buy = readEvents(eventsPath).find(e => e.type === 'RESEARCH_WOULD_BUY');
    expect(buy.brainAction).toBe('PROMOTE');
  });

  it('unknown profiles (no memory / empty) default to WATCH and open normally', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(P1)], '2026-07-01-115500');
    // No policyMemory passed → WATCH.
    const res = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(dir, 'state.json'), eventsPath });
    expect(res.researchBuys).toBe(1);
    expect(res.skippedByBrain).toBe(0);
    const buy = readEvents(eventsPath).find(e => e.type === 'RESEARCH_WOULD_BUY');
    expect(buy.brainAction).toBe('WATCH');
    expect(resolvePolicyStatus(null, partsOf(candidates[0]))).toBe('WATCH');
  });
});

// ── Safety ──────────────────────────────────────────────────────────────────────────────────

describe('brain safety', () => {
  it('renderBrainRefreshReport states READY_FOR_REAL_TRADING=false and paper-only safety', () => {
    const eventsPath = writeEvents(profileEvents(BASE_PROFILE, 'safe', winners(20)));
    const text = renderBrainRefreshReport(refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'm.json'), generatedAt: ISO }));
    expect(text).toContain('READY_FOR_REAL_TRADING=false');
    expect(text).toContain('REAL_TRADING=false');
    expect(text).toContain('NO_WALLET=true');
    expect(text).toContain('NO_SWAP=true');
    expect(text).toContain('NO_SIGNING=true');
    expect(text).toContain('UNKNOWN stays UNKNOWN');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('default memory path lives under data/token-grab/brain/', () => {
    expect(DEFAULT_BRAIN_POLICY_MEMORY_PATH).toBe('data/token-grab/brain/policy-memory.json');
  });

  it('never relabels UNKNOWN as CLEAN and never creates real-trading/wallet/swap/signing code', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/brainPolicy.ts'), 'utf-8');
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
    expect(src).not.toMatch(/execSync|spawn|child_process|token:auto-paper|token:paper-buy/);
    expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
    expect(src).not.toMatch(/READY_FOR_REAL_TRADING\s*=\s*true|readyForRealTrading:\s*true/);
  });

  it('empty stream builds an empty memory without crashing', () => {
    const dir = tmpDir();
    const res = refreshBrainPolicy({ eventsPath: path.join(dir, 'none.jsonl'), memoryPath: path.join(dir, 'm.json'), generatedAt: ISO });
    expect(res.memory.totalProfiles).toBe(0);
    expect(res.readyForRealTrading).toBe(false);
    expect(buildPolicyMemory([], { generatedAt: ISO }).totalProfiles).toBe(0);
  });

  it('loadBrainPolicyMemory re-enforces safety flags from disk', () => {
    const dir = tmpDir();
    const memoryPath = path.join(dir, 'm.json');
    // Simulate a tampered file that tries to flip safety flags.
    fs.writeFileSync(memoryPath, JSON.stringify({ version: 1, profiles: {}, readyForRealTrading: true, realTrading: true, noWallet: false }), 'utf-8');
    const mem = loadBrainPolicyMemory(memoryPath)!;
    expect(mem.readyForRealTrading).toBe(false);
    expect(mem.realTrading).toBe(false);
    expect(mem.noWallet).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// BRAIN v1.1 — GLOBAL POLICY GROUPS
// ════════════════════════════════════════════════════════════════════════════════════════════

// Rotating "other" dimensions so exact profiles stay small while a single fixed dimension's
// GLOBAL group accumulates enough valued samples to act on.
const SCORE_BANDS = ['SCORE_60_79', 'SCORE_80_89', 'SCORE_90_99', 'SCORE_100'];
const M5S  = ['-20 to -5', '-5 to +5'];
const VLRS = ['VLR_LT_0_5', 'VLR_0_5_TO_2', 'VLR_GTE_2'];
const LIQS = ['LIQ_10K_30K', 'LIQ_30K_100K'];

/** Emit events that all share `fixed` on the target dimension but vary the others. */
function globalDimEvents(fixed: Partial<PolicyProfileParts>, tag: string, valuedPnls: number[], unvalued = 0): any[] {
  const out: any[] = [];
  let i = 0;
  const mk = (pnl: number | null, usable: boolean) => {
    const parts: PolicyProfileParts = {
      lane: fixed.lane ?? 'NO_BM_INTERNAL_BROAD',
      productionGateApproved: fixed.productionGateApproved ?? false,
      launchAgeBucket: fixed.launchAgeBucket ?? 'PRIME_WINDOW',
      m5Band: fixed.m5Band ?? M5S[i % M5S.length],
      liquidityBucket: fixed.liquidityBucket ?? LIQS[i % LIQS.length],
      vlrBucket: fixed.vlrBucket ?? VLRS[i % VLRS.length],
      ripperScoreBand: fixed.ripperScoreBand ?? SCORE_BANDS[i % SCORE_BANDS.length],
    };
    const contract = `${tag}${i}${'z'.repeat(43)}`.slice(0, 43);
    const cyc = `cycle-${tag}-${i}`;
    out.push(buyEvent(parts, contract, cyc), sellEvent(parts, contract, cyc, usable, pnl));
    i++;
  };
  for (const pnl of valuedPnls) mk(pnl, true);
  for (let u = 0; u < unvalued; u++) mk(null, false);
  return out;
}

const mixLose = (losers: number, wins: number) => [...Array.from({ length: losers }, () => -20), ...Array.from({ length: wins }, () => 10)];
const mixWin  = (wins: number, losers: number) => [...Array.from({ length: wins }, () => 30), ...Array.from({ length: losers }, () => -10)];

describe('globalPolicyStatus rules (separate from exact)', () => {
  it('valued < 10 → WATCH (TOO_SMALL, not severe)', () => {
    expect(globalPolicyStatus({ valuedClosed: 8, medianPnlPct: -20, cappedAveragePnlPct: -20, redLossRate: 1 })).toBe('WATCH');
  });
  it('valued >= 10, redLoss >= 65%, losing both → DEMOTE', () => {
    expect(globalPolicyStatus({ valuedClosed: 14, medianPnlPct: -5, cappedAveragePnlPct: -9, redLossRate: 0.7 })).toBe('DEMOTE');
  });
  it('valued >= 20, redLoss >= 65%, losing both → KILL', () => {
    expect(globalPolicyStatus({ valuedClosed: 22, medianPnlPct: -5, cappedAveragePnlPct: -9, redLossRate: 0.7 })).toBe('KILL');
  });
  it('valued >= 10, winning both, redLoss <= 50% → PROMOTE_LIGHT', () => {
    expect(globalPolicyStatus({ valuedClosed: 12, medianPnlPct: 4, cappedAveragePnlPct: 8, redLossRate: 0.4 })).toBe('PROMOTE_LIGHT');
  });
  it('valued >= 20, winning both, redLoss <= 45% → PROMOTE', () => {
    expect(globalPolicyStatus({ valuedClosed: 22, medianPnlPct: 4, cappedAveragePnlPct: 8, redLossRate: 0.3 })).toBe('PROMOTE');
  });
  it('globalGroupsForParts yields the six single-dimension slices', () => {
    const keys = globalGroupsForParts(BASE_PROFILE).map(g => g.key);
    expect(keys).toContain('gate:false');
    expect(keys).toContain('age:PRIME_WINDOW');
    expect(keys).toContain('lane:NO_BM_INTERNAL_BROAD');
    expect(keys.length).toBe(6);
  });
});

describe('brain-refresh builds global groups that act while exact profiles stay small', () => {
  it('productionGateApproved=false with losing global stats becomes DEMOTE/KILL', () => {
    // 17 losers + 5 winners = 22 valued, redLoss 77% → global KILL; exact profiles stay small.
    const eventsPath = writeEvents(globalDimEvents({ productionGateApproved: false }, 'gf', mixLose(17, 5)));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'm.json'), generatedAt: ISO });
    const g = res.memory.globalGroups['gate:false'];
    expect(g).toBeTruthy();
    expect(g.valuedClosed).toBe(22);
    expect(['DEMOTE', 'KILL']).toContain(g.policyStatus);
    // Exact profiles all still TOO_SMALL (rotating dims spread the 22 across many keys).
    expect(Object.values(res.memory.profiles).every(p => p.confidenceTier === 'TOO_SMALL')).toBe(true);
  });

  it('launchAgeBucket=TOO_EARLY with losing global stats becomes DEMOTE/KILL', () => {
    const eventsPath = writeEvents(globalDimEvents({ launchAgeBucket: 'TOO_EARLY' }, 'te', mixLose(16, 6)));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'm.json'), generatedAt: ISO });
    const g = res.memory.globalGroups['age:TOO_EARLY'];
    expect(g).toBeTruthy();
    expect(['DEMOTE', 'KILL']).toContain(g.policyStatus);
    expect(res.globalKilled.concat(res.globalDemoted).some(x => x.key === 'age:TOO_EARLY')).toBe(true);
  });

  it('productionGateApproved=true with winning global stats becomes PROMOTE_LIGHT/PROMOTE', () => {
    const eventsPath = writeEvents(globalDimEvents({ productionGateApproved: true }, 'gt', mixWin(18, 4)));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'm.json'), generatedAt: ISO });
    const g = res.memory.globalGroups['gate:true'];
    expect(g).toBeTruthy();
    expect(['PROMOTE', 'PROMOTE_LIGHT']).toContain(g.policyStatus);
    expect(res.globalPromoted.some(x => x.key === 'gate:true')).toBe(true);
  });

  it('global groups exclude unavailable valuations (never counted as flat)', () => {
    const eventsPath = writeEvents(globalDimEvents({ productionGateApproved: true }, 'gu', winners(12), 8));
    const res = refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'm.json'), generatedAt: ISO });
    const g = res.memory.globalGroups['gate:true'];
    expect(g.valuedClosed).toBe(12);
    expect(g.unvaluedClosed).toBe(8);
    expect(g.flats).toBe(0);   // unvalued NOT counted as flat
  });
});

describe('resolveBrainDecision precedence (exact first, then global)', () => {
  it('exact KILL overrides global PROMOTE', () => {
    const memory = memoryWithGlobal(BASE_PROFILE, `lane:${BASE_PROFILE.lane}`, 'PROMOTE', 'KILL');
    const d = resolveBrainDecision(memory, BASE_PROFILE);
    expect(d.action).toBe('SKIP');
    expect(d.status).toBe('KILL');
    expect(d.source).toBe('EXACT');
  });
  it('global KILL skips when exact is WATCH', () => {
    const memory = memoryWithGlobal(BASE_PROFILE, `lane:${BASE_PROFILE.lane}`, 'KILL');
    const d = resolveBrainDecision(memory, BASE_PROFILE);
    expect(d.action).toBe('SKIP');
    expect(d.source).toBe('GLOBAL');
  });
  it('global PROMOTE_LIGHT annotates PROMOTE (opens)', () => {
    const memory = memoryWithGlobal(BASE_PROFILE, `gate:${BASE_PROFILE.productionGateApproved}`, 'PROMOTE_LIGHT');
    const d = resolveBrainDecision(memory, BASE_PROFILE);
    expect(d.action).toBe('OPEN');
    expect(d.status).toBe('PROMOTE');
  });
});

describe('research-shadow honors GLOBAL brain policy', () => {
  const GK = 'GlobKill11111111111111111111111111111111A1';
  const GD = 'GlobDemo11111111111111111111111111111111A1';

  it('skips based on a global KILL group (RESEARCH_SKIPPED_BY_BRAIN, source GLOBAL)', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(GK)], '2026-07-01-115500');
    const parts = partsOf(candidates[0]);
    const memory = memoryWithGlobal(parts, `lane:${parts.lane}`, 'KILL');   // exact WATCH, global KILL

    const res = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(dir, 'state.json'), eventsPath, policyMemory: memory });

    expect(res.researchBuys).toBe(0);
    expect(res.skippedByBrain).toBe(1);
    const skip = readEvents(eventsPath).find(e => e.type === 'RESEARCH_SKIPPED_BY_BRAIN');
    expect(skip.brainStatus).toBe('KILL');
    expect(skip.reason).toContain('GLOBAL');
    expect(skip.realTrading).toBe(false);
  });

  it('demotes based on a global DEMOTE group (skip by default, open in observation mode)', () => {
    const { candidates, sourceCycle } = resolveCycle([cycleRow(GD)], '2026-07-01-115500');
    const parts = partsOf(candidates[0]);
    const memory = memoryWithGlobal(parts, `age:${parts.launchAgeBucket}`, 'DEMOTE');

    const d1 = tmpDir();
    const r1 = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(d1, 's.json'), eventsPath: path.join(d1, 'e.jsonl'), policyMemory: memory });
    expect(r1.researchBuys).toBe(0);
    expect(r1.skippedByBrain).toBe(1);

    const d2 = tmpDir();
    const r2 = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(d2, 's.json'), eventsPath: path.join(d2, 'e.jsonl'), policyMemory: memory, observationMode: true });
    expect(r2.researchBuys).toBe(1);
    const buy = readEvents(path.join(d2, 'e.jsonl')).find(e => e.type === 'RESEARCH_WOULD_BUY');
    expect(buy.brainAction).toBe('DEMOTE_OBSERVATION');
  });

  it('exact KILL overrides a global PROMOTE for the same candidate (skips)', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const { candidates, sourceCycle } = resolveCycle([cycleRow(GK)], '2026-07-01-115500');
    const parts = partsOf(candidates[0]);
    const memory = memoryWithGlobal(parts, `lane:${parts.lane}`, 'PROMOTE', 'KILL');

    const res = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(dir, 'state.json'), eventsPath, policyMemory: memory });
    expect(res.researchBuys).toBe(0);
    expect(res.skippedByBrain).toBe(1);
    const skip = readEvents(eventsPath).find(e => e.type === 'RESEARCH_SKIPPED_BY_BRAIN');
    expect(skip.reason).toContain('EXACT');
  });
});

describe('brain v1.1 report + safety', () => {
  it('report shows exact AND global statuses and paper-only research policy language', () => {
    const eventsPath = writeEvents([
      ...globalDimEvents({ productionGateApproved: false }, 'rf', mixLose(17, 5)),
      ...globalDimEvents({ productionGateApproved: true }, 'rt', mixWin(18, 4)),
    ]);
    const text = renderBrainRefreshReport(refreshBrainPolicy({ eventsPath, memoryPath: path.join(path.dirname(eventsPath), 'm.json'), generatedAt: ISO }));
    expect(text).toContain('EXACT PROFILE STATUSES');
    expect(text).toContain('GLOBAL POLICY GROUP STATUSES');
    expect(text).toContain('PAPER-ONLY research policies');
    expect(text).toContain('READY_FOR_REAL_TRADING=false');
    expect(text).toContain('UNKNOWN stays UNKNOWN');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// BRAIN v1.2 — KILL HYSTERESIS
// ════════════════════════════════════════════════════════════════════════════════════════════

const T1 = '2026-07-01T10:00:00.000Z';   // pre-kill trades
const R1 = '2026-07-01T11:00:00.000Z';   // refresh 1 (kill anchor)
const T2 = '2026-07-01T12:00:00.000Z';   // post-kill trades
const R2 = '2026-07-01T13:00:00.000Z';   // refresh 2
const R3 = '2026-07-01T14:00:00.000Z';   // refresh 3

/** Emit buy+sell pairs pinned on one dimension, all stamped with an explicit ts. */
function dimEventsAt(fixed: Partial<PolicyProfileParts>, tag: string, valuedPnls: number[], ts: string): any[] {
  const out: any[] = [];
  let i = 0;
  for (const pnl of valuedPnls) {
    const parts: PolicyProfileParts = {
      lane: fixed.lane ?? 'NO_BM_INTERNAL_BROAD',
      productionGateApproved: fixed.productionGateApproved ?? false,
      launchAgeBucket: fixed.launchAgeBucket ?? 'PRIME_WINDOW',
      m5Band: fixed.m5Band ?? M5S[i % M5S.length],
      liquidityBucket: fixed.liquidityBucket ?? LIQS[i % LIQS.length],
      vlrBucket: fixed.vlrBucket ?? VLRS[i % VLRS.length],
      ripperScoreBand: fixed.ripperScoreBand ?? SCORE_BANDS[i % SCORE_BANDS.length],
    };
    const contract = `${tag}${i}${'z'.repeat(43)}`.slice(0, 43);
    const cyc = `cyc-${tag}-${i}`;
    const b: any = buyEvent(parts, contract, cyc); b.ts = ts;
    const s: any = sellEvent(parts, contract, cyc, true, pnl); s.ts = ts;
    out.push(b, s);
    i++;
  }
  return out;
}
function writeLines(p: string, events: any[]) { fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8'); }
function appendLines(p: string, events: any[]) { fs.appendFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8'); }

describe('applyKillHysteresis (pure)', () => {
  it('isRecovered requires >=20 valued, median>0, cappedAvg>0, redLoss<=45%', () => {
    expect(isRecovered({ valuedClosed: 20, medianPnlPct: 5, cappedAveragePnlPct: 10, redLossRate: 0.3 })).toBe(true);
    expect(isRecovered({ valuedClosed: 19, medianPnlPct: 5, cappedAveragePnlPct: 10, redLossRate: 0.3 })).toBe(false);  // too few
    expect(isRecovered({ valuedClosed: 20, medianPnlPct: -1, cappedAveragePnlPct: 10, redLossRate: 0.3 })).toBe(false); // median<0
    expect(isRecovered({ valuedClosed: 20, medianPnlPct: 5, cappedAveragePnlPct: 10, redLossRate: 0.5 })).toBe(false);  // redLoss>45%
    expect(KILL_HYSTERESIS.recoveryMinValued).toBe(20);
  });

  it('newly killed anchors killedAt = generatedAt and priorStatus', () => {
    const r = applyKillHysteresis({ freshStatus: 'KILL', freshIsKill: true, freshKillReason: 'r', prevStatus: 'WATCH', prevKilledAt: null, prevKillReason: null, prevPriorStatus: null, postKill: { valuedClosed: 0, medianPnlPct: null, cappedAveragePnlPct: null, redLossRate: 0 }, generatedAt: R1 });
    expect(r.policyStatus).toBe('KILL');
    expect(r.meta.killedAt).toBe(R1);
    expect(r.meta.priorStatus).toBe('WATCH');
    expect(r.meta.recoveryState).toBe('KILLED');
  });

  it('PROMOTE fresh does NOT override a sticky KILL that has not recovered', () => {
    const r = applyKillHysteresis({ freshStatus: 'PROMOTE', freshIsKill: false, freshKillReason: null, prevStatus: 'KILL', prevKilledAt: R1, prevKillReason: 'r', prevPriorStatus: 'WATCH', postKill: { valuedClosed: 15, medianPnlPct: 30, cappedAveragePnlPct: 30, redLossRate: 0 }, generatedAt: R2 });
    expect(r.policyStatus).toBe('KILL');   // stays killed despite PROMOTE-looking fresh stats
    expect(r.recovered).toBe(false);
    expect(r.meta.recoveryState).toBe('RECOVERING');
    expect(r.meta.killedAt).toBe(R1);      // anchor preserved
  });

  it('recovers only when post-kill evidence meets ALL criteria', () => {
    const r = applyKillHysteresis({ freshStatus: 'WATCH', freshIsKill: false, freshKillReason: null, prevStatus: 'KILL', prevKilledAt: R1, prevKillReason: 'r', prevPriorStatus: 'WATCH', postKill: { valuedClosed: 22, medianPnlPct: 5, cappedAveragePnlPct: 12, redLossRate: 0.2 }, generatedAt: R2 });
    expect(r.recovered).toBe(true);
    expect(r.policyStatus).not.toBe('KILL');
    expect(r.meta.killedAt).toBeNull();
  });
});

describe('KILL hysteresis via refresh (stateful)', () => {
  it('killed group remains KILL after only marginal (insufficient) post-kill improvement', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'research-shadow-events.jsonl');
    const memoryPath = path.join(dir, 'm.json');
    writeLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'k', mixLose(17, 5), T1));   // 22 valued, redLoss 77%
    const r1 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R1 });
    expect(r1.memory.globalGroups['gate:false'].policyStatus).toBe('KILL');
    expect(r1.memory.globalGroups['gate:false'].killedAt).toBe(R1);

    // Only 5 post-kill winners (< 20 recovery threshold) — marginal all-time improvement.
    appendLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'p', winners(5), T2));
    const r2 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R2 });
    const g = r2.memory.globalGroups['gate:false'];
    expect(g.policyStatus).toBe('KILL');            // STILL killed
    expect(g.killedAt).toBe(R1);                    // same anchor persists
    expect(g.recoveryState).toBe('RECOVERING');
    expect(g.postKillValuedClosed).toBe(5);
    expect(g.recoveryProgress).toBeCloseTo(5 / 20, 5);
  });

  it('killed group only recovers after ENOUGH post-kill positive evidence (19 → still KILL, 20 → recover)', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'research-shadow-events.jsonl');
    const memoryPath = path.join(dir, 'm.json');
    writeLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'k', mixLose(17, 5), T1));
    refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R1 });

    // 19 post-kill winners — one short of the recovery minimum.
    appendLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'p', winners(19), T2));
    const r2 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R2 });
    expect(r2.memory.globalGroups['gate:false'].policyStatus).toBe('KILL');

    // One more post-kill winner → 20 total post-kill → recovers.
    appendLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'q', winners(1), T2));
    const r3 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R3 });
    const g = r3.memory.globalGroups['gate:false'];
    expect(g.policyStatus).not.toBe('KILL');
    expect(g.killedAt).toBeNull();
    expect(r3.recovered).toContain('gate:false');
  });

  it('exact-profile KILL is also sticky across refreshes', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'research-shadow-events.jsonl');
    const memoryPath = path.join(dir, 'm.json');
    // Pin ALL 7 dims (BASE_PROFILE) so one exact profile accumulates the whole sample:
    // 10 valued (9 losers + 1 winner) → redLoss 90% → exact KILL (>=75%, valued>=10).
    const fixed: PolicyProfileParts = { ...BASE_PROFILE };
    writeLines(eventsPath, dimEventsAt(fixed, 'ex', [...losers(9), 10], T1));
    const r1 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R1 });
    const key = policyProfileKey(fixed);
    expect(r1.memory.profiles[key].policyStatus).toBe('KILL');
    expect(r1.memory.profiles[key].killedAt).toBe(R1);
    // Marginal post-kill improvement (few winners) — exact profile stays KILL (sticky).
    appendLines(eventsPath, dimEventsAt(fixed, 'exp', winners(3), T2));
    const r2 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R2 });
    expect(r2.memory.profiles[key].policyStatus).toBe('KILL');
    expect(r2.memory.profiles[key].killedAt).toBe(R1);
  });
});

describe('research-shadow skips a STICKY KILL', () => {
  it('a sticky-killed (RECOVERING) global group still suppresses new research opens', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'events.jsonl');
    const { candidates, sourceCycle } = resolveCycle([cycleRow('StickyKill1111111111111111111111111111111A')], '2026-07-01-115500');
    const parts = partsOf(candidates[0]);
    const memory = memoryWithGlobal(parts, `lane:${parts.lane}`, 'KILL');
    // Make it explicitly a sticky, mid-recovery kill.
    memory.globalGroups[`lane:${parts.lane}`].killedAt = R1;
    memory.globalGroups[`lane:${parts.lane}`].recoveryState = 'RECOVERING';
    memory.globalGroups[`lane:${parts.lane}`].postKillValuedClosed = 8;

    const res = recordResearchShadow({ candidates, sourceCycle, nowMs: NOW_MS, statePath: path.join(dir, 's.json'), eventsPath, policyMemory: memory });
    expect(res.researchBuys).toBe(0);
    expect(res.skippedByBrain).toBe(1);
    const skip = readEvents(eventsPath).find(e => e.type === 'RESEARCH_SKIPPED_BY_BRAIN');
    expect(skip.brainStatus).toBe('KILL');
  });
});

describe('brain v1.2 report + safety', () => {
  it('sticky-kill section + kill age render, safety strings preserved', () => {
    const dir = tmpDir();
    const eventsPath = path.join(dir, 'research-shadow-events.jsonl');
    const memoryPath = path.join(dir, 'm.json');
    writeLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'k', mixLose(17, 5), T1));
    refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R1 });
    appendLines(eventsPath, dimEventsAt({ productionGateApproved: false }, 'p', winners(3), T2));
    const r2 = refreshBrainPolicy({ eventsPath, memoryPath, generatedAt: R2 });
    const text = renderBrainRefreshReport(r2);
    expect(text).toContain('STICKY KILL / RECOVERY');
    expect(text).toContain('killed');            // kill age line
    expect(text).toContain('recovery');
    expect(text).toContain('READY_FOR_REAL_TRADING=false');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('UNKNOWN stays UNKNOWN');
  });
});
