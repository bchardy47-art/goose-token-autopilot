import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  refreshBrainPolicy,
  buildPolicyMemory,
  policyProfileKey,
  policyStatus,
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
    const change = res2.changes.find(c => c.kind === 'STATUS_CHANGE');
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
    version: 1, generatedAt: ISO, eventsPath: 'x', totalProfiles: 1,
    profiles: {
      [policyProfileKey(parts)]: {
        ...parts, key: policyProfileKey(parts), sampleSize: 30, valuedClosed: 25, unvaluedClosed: 0,
        wins: status === 'PROMOTE' ? 20 : 5, losses: status === 'PROMOTE' ? 5 : 20, flats: 0,
        medianPnlPct: status === 'PROMOTE' ? 8 : -8, cappedAveragePnlPct: status === 'PROMOTE' ? 18 : -18,
        redLossRate: status === 'PROMOTE' ? 0.2 : 0.8, bestTrade: null, worstTrade: null,
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
