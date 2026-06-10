import { describe, it, expect, vi } from 'vitest';
import {
  enrichCandidateResult,
  buildDexCandidateSafetyEnrichReport,
  renderDexCandidateSafetyEnrichReport,
  renderDexCandidateSafetyEnrichUsage,
  offlineSafetyProvider,
  holderPctToStatus,
  type SolanaTokenSafetyProvider,
  type EnrichedCandidate,
} from '../src/token-grab/dexCandidateSafetyEnrich';
import type { WinnerCandidate, DexWinnerCandidateReport } from '../src/token-grab/dexWinnerCandidateReport';

// ── Test fixtures ──────────────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<WinnerCandidate> = {}): WinnerCandidate {
  return {
    tier: 'HIGH_CONVICTION_WATCH',
    contract: 'XRPS1111111111111111111111111111111111111111',
    symbol: 'XRPS',
    confidence: 'MEDIUM',
    reasons: ['price +34.3%', 'liquidity +15.8%', 'paper: MAX_HOLD_TIMEOUT +$0.34'],
    missingSafetySignals: ['MINT_FREEZE_NOT_CONNECTED', 'HOLDER_MAP_NOT_CONNECTED'],
    priceChangePct: 34.3,
    liquidityChangePct: 15.8,
    volumeLiquidityRatio: 0.50,
    paperExitReason: 'MAX_HOLD_TIMEOUT',
    paperFakePnlDollars: 0.34,
    ...overrides,
  };
}

function makeWinnerReport(candidates: WinnerCandidate[], rejectedCount = 5): DexWinnerCandidateReport {
  const passToHumanCount = candidates.filter(c => c.tier === 'PASS_TO_HUMAN').length;
  const highConvictionWatchCount = candidates.filter(c => c.tier === 'HIGH_CONVICTION_WATCH').length;
  const watchCount = candidates.filter(c => c.tier === 'WATCH').length;
  let finalRecommendation: DexWinnerCandidateReport['finalRecommendation'] = 'NO_CANDIDATES';
  if (passToHumanCount > 0) finalRecommendation = 'PASS_TO_HUMAN';
  else if (highConvictionWatchCount > 0) finalRecommendation = 'HIGH_CONVICTION_WATCH';
  else if (watchCount > 0) finalRecommendation = 'WATCH';
  return {
    generatedAt: '2026-06-10T00:00:00.000Z',
    sourceFile: 'test-candidates.json',
    candidateCount: candidates.length,
    passToHumanCount,
    highConvictionWatchCount,
    watchCount,
    rejectedCount,
    rejectCategoryCounts: { BLOCKED_HISTORY: rejectedCount },
    candidates,
    finalRecommendation,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

// Clean mock provider — renounced mint/freeze, 8% top holder.
function cleanProvider(overrides: Partial<SolanaTokenSafetyProvider> = {}): SolanaTokenSafetyProvider {
  return {
    fetchMintAuthority: async (_c) => 'RENOUNCED',
    fetchFreezeAuthority: async (_c) => 'RENOUNCED',
    fetchTopHolderPct: async (_c) => 8,
    ...overrides,
  };
}

// ── holderPctToStatus ──────────────────────────────────────────────────────────────────────

describe('holderPctToStatus', () => {
  it('returns UNKNOWN for null', () => {
    expect(holderPctToStatus(null)).toBe('UNKNOWN');
  });

  it('returns DANGER for >= 30%', () => {
    expect(holderPctToStatus(30)).toBe('DANGER');
    expect(holderPctToStatus(35)).toBe('DANGER');
    expect(holderPctToStatus(99)).toBe('DANGER');
  });

  it('returns WARNING for 15% to 29.9%', () => {
    expect(holderPctToStatus(15)).toBe('WARNING');
    expect(holderPctToStatus(18)).toBe('WARNING');
    expect(holderPctToStatus(29.9)).toBe('WARNING');
  });

  it('returns CLEAN for < 15%', () => {
    expect(holderPctToStatus(8)).toBe('CLEAN');
    expect(holderPctToStatus(0)).toBe('CLEAN');
    expect(holderPctToStatus(14.9)).toBe('CLEAN');
  });
});

// ── enrichCandidateResult — hard kills ────────────────────────────────────────────────────

describe('enrichCandidateResult — hard kills', () => {
  it('freeze authority ACTIVE kills candidate', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.killReasons.some(r => r.includes('freeze authority ACTIVE'))).toBe(true);
    }
  });

  it('top holder 35% kills candidate (DANGER)', async () => {
    const result = await enrichCandidateResult(
      makeCandidate(),
      cleanProvider({ fetchTopHolderPct: async () => 35 }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.killReasons.some(r => r.includes('35') || r.includes('DANGER'))).toBe(true);
    }
  });

  it('top holder exactly 30% kills candidate', async () => {
    const result = await enrichCandidateResult(
      makeCandidate(),
      cleanProvider({ fetchTopHolderPct: async () => 30 }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.killReasons.length).toBeGreaterThan(0);
    }
  });

  it('both freeze ACTIVE and holder DANGER are captured in kill reasons', async () => {
    const result = await enrichCandidateResult(
      makeCandidate(),
      cleanProvider({
        fetchFreezeAuthority: async () => 'ACTIVE',
        fetchTopHolderPct: async () => 35,
      }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.killReasons.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('killed candidate carries correct symbol and contract', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ symbol: 'FREEZETEST', contract: 'FREEZE111' }),
      cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.symbol).toBe('FREEZETEST');
      expect(result.killed.contract).toBe('FREEZE111');
    }
  });
});

// ── enrichCandidateResult — soft downgrades ───────────────────────────────────────────────

describe('enrichCandidateResult — soft downgrades', () => {
  it('top holder 18% downgrades candidate to WATCH', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider({ fetchTopHolderPct: async () => 18 }),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('WATCH');
      expect(result.candidate.holderConcentrationStatus).toBe('WARNING');
    }
  });

  it('top holder 8% keeps candidate at original tier', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider({ fetchTopHolderPct: async () => 8 }),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('PASS_TO_HUMAN');
      expect(result.candidate.holderConcentrationStatus).toBe('CLEAN');
      expect(result.candidate.topHolderPercent).toBe(8);
    }
  });

  it('mint authority ACTIVE prevents PASS_TO_HUMAN — caps at HIGH_CONVICTION_WATCH', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider({ fetchMintAuthority: async () => 'ACTIVE' }),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('HIGH_CONVICTION_WATCH');
      expect(result.candidate.mintAuthorityStatus).toBe('ACTIVE');
    }
  });

  it('mint ACTIVE on HIGH_CONVICTION_WATCH candidate stays HIGH_CONVICTION_WATCH', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'HIGH_CONVICTION_WATCH' }),
      cleanProvider({ fetchMintAuthority: async () => 'ACTIVE' }),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('HIGH_CONVICTION_WATCH');
    }
  });

  it('mint ACTIVE + holder WARNING → WATCH (worst downgrade wins)', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider({
        fetchMintAuthority: async () => 'ACTIVE',
        fetchTopHolderPct: async () => 20,
      }),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('WATCH');
    }
  });
});

// ── enrichCandidateResult — UNKNOWN / offline ─────────────────────────────────────────────

describe('enrichCandidateResult — UNKNOWN / offline', () => {
  it('UNKNOWN RPC does not crash — preserves WATCH or HCW with missingSignals', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'HIGH_CONVICTION_WATCH' }),
      offlineSafetyProvider,
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(['HIGH_CONVICTION_WATCH', 'WATCH']).toContain(result.candidate.safetyVerdict);
      expect(result.candidate.missingSignals).toContain('MINT_FREEZE_NOT_CONNECTED');
      expect(result.candidate.missingSignals).toContain('HOLDER_MAP_NOT_CONNECTED');
    }
  });

  it('offline provider returns UNKNOWN for all statuses without crashing', async () => {
    const result = await enrichCandidateResult(makeCandidate(), offlineSafetyProvider);
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.mintAuthorityStatus).toBe('UNKNOWN');
      expect(result.candidate.freezeAuthorityStatus).toBe('UNKNOWN');
      expect(result.candidate.holderConcentrationStatus).toBe('UNKNOWN');
      expect(result.candidate.topHolderPercent).toBeUndefined();
    }
  });

  it('provider throw on fetchMintAuthority does not crash — falls back to UNKNOWN', async () => {
    const provider: SolanaTokenSafetyProvider = {
      fetchMintAuthority: async () => { throw new Error('RPC error'); },
      fetchFreezeAuthority: async () => 'RENOUNCED',
      fetchTopHolderPct: async () => 5,
    };
    const result = await enrichCandidateResult(makeCandidate(), provider);
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.mintAuthorityStatus).toBe('UNKNOWN');
    }
  });
});

// ── enrichCandidateResult — mocked XRPS-style golden path ────────────────────────────────

describe('enrichCandidateResult — mocked scenarios', () => {
  it('XRPS-style candidate survives as HIGH_CONVICTION_WATCH with all statuses clean', async () => {
    const candidate = makeCandidate({
      tier: 'HIGH_CONVICTION_WATCH',
      symbol: 'XRPS',
      contract: '7XLu71Wvq7zuNU7TP5qjYY8kqg9zxtrsb7sJEEF6pump',
      priceChangePct: 34.3,
      liquidityChangePct: 15.8,
      volumeLiquidityRatio: 0.50,
      paperExitReason: 'MAX_HOLD_TIMEOUT',
      paperFakePnlDollars: 0.34,
    });
    const result = await enrichCandidateResult(candidate, cleanProvider());
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('HIGH_CONVICTION_WATCH');
      expect(result.candidate.mintAuthorityStatus).toBe('RENOUNCED');
      expect(result.candidate.freezeAuthorityStatus).toBe('RENOUNCED');
      expect(result.candidate.holderConcentrationStatus).toBe('CLEAN');
      expect(result.candidate.topHolderPercent).toBe(8);
      expect(result.candidate.missingSignals).toHaveLength(0);
    }
  });

  it('freeze ACTIVE kills candidate (mocked, full flow)', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN', symbol: 'FREEZETOKEN' }),
      cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.killReasons.some(r => r.includes('freeze authority ACTIVE'))).toBe(true);
    }
  });

  it('top holder 35% kills candidate (mocked, full flow)', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'HIGH_CONVICTION_WATCH', symbol: 'WHALECOIN' }),
      cleanProvider({ fetchTopHolderPct: async () => 35 }),
    );
    expect(result.type).toBe('killed');
    if (result.type === 'killed') {
      expect(result.killed.killReasons.some(r => r.includes('35') || r.includes('DANGER'))).toBe(true);
    }
  });

  it('PASS_TO_HUMAN with clean safety stays PASS_TO_HUMAN', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider(),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.safetyVerdict).toBe('PASS_TO_HUMAN');
      expect(result.candidate.missingSignals).toHaveLength(0);
    }
  });

  it('survivor carries originalTier field', async () => {
    const result = await enrichCandidateResult(
      makeCandidate({ tier: 'PASS_TO_HUMAN' }),
      cleanProvider({ fetchMintAuthority: async () => 'ACTIVE' }),
    );
    expect(result.type).toBe('survivor');
    if (result.type === 'survivor') {
      expect(result.candidate.originalTier).toBe('PASS_TO_HUMAN');
      expect(result.candidate.safetyVerdict).toBe('HIGH_CONVICTION_WATCH');
    }
  });
});

// ── buildDexCandidateSafetyEnrichReport ───────────────────────────────────────────────────

describe('buildDexCandidateSafetyEnrichReport', () => {
  it('enrichment only calls provider for candidates, not rejected tokens', async () => {
    const calls: string[] = [];
    const provider: SolanaTokenSafetyProvider = {
      fetchMintAuthority: async (c) => { calls.push(c); return 'RENOUNCED'; },
      fetchFreezeAuthority: async () => 'RENOUNCED',
      fetchTopHolderPct: async () => 5,
    };
    // rejectedCount = 5 but no rejected contracts in the non-debug winner report
    const winnerReport = makeWinnerReport([makeCandidate()], 5);
    await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider,
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    // Provider called exactly once — for the single candidate, not the 5 rejected tokens
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('XRPS1111111111111111111111111111111111111111');
  });

  it('counts survivors and kills correctly', async () => {
    const c1 = makeCandidate({ contract: 'AA', symbol: 'AA' });
    const c2 = makeCandidate({ contract: 'BB', symbol: 'BB' });
    const c3 = makeCandidate({ contract: 'CC', symbol: 'CC' });
    const winnerReport = makeWinnerReport([c1, c2, c3]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: cleanProvider({
        fetchFreezeAuthority: async (c) => c === 'BB' ? 'ACTIVE' : 'RENOUNCED',
      }),
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.candidatesEnriched).toBe(3);
    expect(report.killedCount).toBe(1);
    expect(report.candidates).toHaveLength(2);
  });

  it('debug mode includes killed array', async () => {
    const winnerReport = makeWinnerReport([makeCandidate()]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
      debug: true,
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.killed).toBeDefined();
    expect(report.killed!.length).toBe(1);
  });

  it('non-debug mode excludes killed array', async () => {
    const winnerReport = makeWinnerReport([makeCandidate()]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
      debug: false,
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.killed).toBeUndefined();
  });

  it('finalRecommendation = PASS_TO_HUMAN when a surviving candidate is PASS_TO_HUMAN', async () => {
    const winnerReport = makeWinnerReport([makeCandidate({ tier: 'PASS_TO_HUMAN' })]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: cleanProvider(),
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.finalRecommendation).toBe('PASS_TO_HUMAN');
  });

  it('finalRecommendation = NO_SURVIVORS when all candidates are killed', async () => {
    const winnerReport = makeWinnerReport([makeCandidate()]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.finalRecommendation).toBe('NO_SURVIVORS');
    expect(report.candidates).toHaveLength(0);
  });

  it('report carries all required safety fields', async () => {
    const winnerReport = makeWinnerReport([makeCandidate()]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: offlineSafetyProvider,
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.tradingExecuted).toBe(0);
    expect(report.noRealTradeSent).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
    expect(report.rpcAvailable).toBe(false);
  });

  it('empty winner report produces NO_SURVIVORS with zero counts', async () => {
    const winnerReport = makeWinnerReport([]);
    const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider: cleanProvider(),
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
    expect(report.finalRecommendation).toBe('NO_SURVIVORS');
    expect(report.candidatesEnriched).toBe(0);
    expect(report.killedCount).toBe(0);
    expect(report.candidates).toHaveLength(0);
  });
});

// ── renderDexCandidateSafetyEnrichReport ──────────────────────────────────────────────────

describe('renderDexCandidateSafetyEnrichReport', () => {
  async function buildReport(
    candidates: WinnerCandidate[],
    provider: SolanaTokenSafetyProvider,
    debug = false,
  ) {
    const winnerReport = makeWinnerReport(candidates);
    return buildDexCandidateSafetyEnrichReport(winnerReport, {
      sourceFile: 'test.json',
      provider,
      debug,
      generatedAt: '2026-06-10T00:00:00.000Z',
    });
  }

  it('normal renderer shows surviving candidate symbol and verdict', async () => {
    const report = await buildReport(
      [makeCandidate({ tier: 'PASS_TO_HUMAN', symbol: 'XRPS' })],
      cleanProvider(),
    );
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('XRPS');
    expect(rendered).toContain('PASS_TO_HUMAN');
  });

  it('normal renderer does not show killed token symbol', async () => {
    const report = await buildReport(
      [makeCandidate({ tier: 'PASS_TO_HUMAN', symbol: 'TOKENKILL' })],
      cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
      true, // debug mode on in builder so killed array is populated
    );
    const rendered = renderDexCandidateSafetyEnrichReport(report, false); // render WITHOUT debug
    expect(rendered).not.toContain('TOKENKILL');
    expect(rendered).toContain('Killed silently: 1');
  });

  it('debug renderer shows killed token symbol and reason', async () => {
    const report = await buildReport(
      [makeCandidate({ tier: 'HIGH_CONVICTION_WATCH', symbol: 'DEADTOKEN' })],
      cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
      true,
    );
    const rendered = renderDexCandidateSafetyEnrichReport(report, true);
    expect(rendered).toContain('DEADTOKEN');
    expect(rendered).toContain('freeze authority ACTIVE');
    expect(rendered).toContain('Killed (debug)');
  });

  it('renderer shows "Killed silently: X" in normal mode', async () => {
    const report = await buildReport(
      [makeCandidate()],
      cleanProvider({ fetchTopHolderPct: async () => 35 }),
      true,
    );
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('Killed silently: 1');
    expect(rendered).not.toContain('Killed (debug)');
  });

  it('renderer shows "No survivors this cycle." when all killed', async () => {
    const report = await buildReport(
      [makeCandidate()],
      cleanProvider({ fetchFreezeAuthority: async () => 'ACTIVE' }),
    );
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('No survivors this cycle.');
  });

  it('renderer shows RPC offline notice when rpcAvailable is false', async () => {
    const report = await buildReport([makeCandidate()], offlineSafetyProvider);
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('SOLANA_RPC_URL not set');
  });

  it('renderer shows safety banner and footer on every report', async () => {
    const report = await buildReport([makeCandidate()], offlineSafetyProvider);
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('PAPER ONLY');
    expect(rendered).toContain('tradingExecuted: 0');
    expect(rendered).toContain('token:auto-paper was NOT run');
    expect(rendered).toContain('NO REAL TRADE SENT');
    expect(rendered).toContain('No wallet');
  });

  it('renderer shows mint/freeze/holder status line for surviving candidate', async () => {
    const report = await buildReport(
      [makeCandidate()],
      cleanProvider(),
    );
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('mint: RENOUNCED');
    expect(rendered).toContain('freeze: RENOUNCED');
    expect(rendered).toContain('holder: CLEAN');
    expect(rendered).toContain('(8.0%)');
  });

  it('renderer shows missing signals for UNKNOWN statuses', async () => {
    const report = await buildReport([makeCandidate()], offlineSafetyProvider);
    const rendered = renderDexCandidateSafetyEnrichReport(report, false);
    expect(rendered).toContain('missing:');
    expect(rendered).toContain('MINT_FREEZE_NOT_CONNECTED');
    expect(rendered).toContain('HOLDER_MAP_NOT_CONNECTED');
  });
});

// ── renderDexCandidateSafetyEnrichUsage ───────────────────────────────────────────────────

describe('renderDexCandidateSafetyEnrichUsage', () => {
  it('usage string contains all required flags', () => {
    const usage = renderDexCandidateSafetyEnrichUsage();
    expect(usage).toContain('--candidates');
    expect(usage).toContain('--out');
    expect(usage).toContain('--rpc-url');
    expect(usage).toContain('--offline');
    expect(usage).toContain('--debug');
    expect(usage).toContain('--json');
    expect(usage).toContain('--help');
  });

  it('usage string mentions safety constraints', () => {
    const usage = renderDexCandidateSafetyEnrichUsage();
    expect(usage).toContain('tradingExecuted: 0');
    expect(usage).toContain('No wallet');
    expect(usage).toContain('No real trade');
  });

  it('usage string describes hard kill rules', () => {
    const usage = renderDexCandidateSafetyEnrichUsage();
    expect(usage).toContain('freeze authority ACTIVE');
    expect(usage).toContain('>= 30%');
    expect(usage).toContain('DANGER');
  });

  it('usage string describes soft downgrade rules', () => {
    const usage = renderDexCandidateSafetyEnrichUsage();
    expect(usage).toContain('mint authority ACTIVE');
    expect(usage).toContain('PASS_TO_HUMAN');
    expect(usage).toContain('15–29%');
  });
});
