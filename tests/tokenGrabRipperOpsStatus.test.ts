import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runRipperOpsStatus,
  renderRipperOpsStatus,
} from '../src/token-grab/ripperOpsStatus';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-ops-status-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

describe('runRipperOpsStatus', () => {
  it('aggregates pipeline, bankroll, brain, freshness, and safety into one status view', () => {
    const cyclesDir = path.join(tmpDir, 'cycles');
    const intentsPath = path.join(tmpDir, 'paper-intents.jsonl');
    const exitPolicyPath = path.join(tmpDir, 'paper-exit-policy-report.jsonl');
    const timingReportPath = path.join(tmpDir, 'approved-entry-timing-report.jsonl');
    const realVsFakePath = path.join(tmpDir, 'real-vs-fake-autopsy.jsonl');
    const liveShadowStatePath = path.join(tmpDir, 'live-shadow-state.json');
    const researchEventsPath = path.join(tmpDir, 'research-shadow-events.jsonl');
    const researchStatePath = path.join(tmpDir, 'research-shadow-state.json');
    const brainMemoryPath = path.join(tmpDir, 'policy-memory.json');
    const learningLockPath = path.join(tmpDir, 'learning.lock');
    const liveShadowLockPath = path.join(tmpDir, 'live-shadow.lock');

    fs.mkdirSync(cyclesDir, { recursive: true });
    writeJsonl(path.join(cyclesDir, 'cycle-2026-10-30-000100.jsonl'), [
      {
        capturedAt: '2026-10-30T00:01:30.000Z',
        buyGateDecision: 'BUY_APPROVED_PAPER',
        normalizedSignal: { contract: 'A', symbol: 'AAA' },
        raw: { clusterRisk: 'UNKNOWN' },
      },
      {
        capturedAt: '2026-10-30T00:01:45.000Z',
        buyGateDecision: 'BUY_REJECTED',
        normalizedSignal: { contract: 'B', symbol: 'BBB' },
        raw: { clusterRisk: 'UNKNOWN' },
      },
    ]);

    writeJsonl(intentsPath, [
      {
        intentId: 'i1',
        contract: 'A',
        symbol: 'AAA',
        approvedAt: '2026-10-30T00:01:30.000Z',
        targetEntryAt: '2026-10-30T00:11:30.000Z',
        paperEntryTiming: 'WAIT_10M',
        reason: 'HIGH_QUALITY_WAIT10_SUBGROUP',
        sourceCycle: 'cycle-2026-10-30-000100',
        clusterRisk: 'UNKNOWN',
        ripperScore: 92,
        launchAgeBucket: 'PRIME_WINDOW',
        entryDecision: 'READY_TO_SNIPE_PAPER',
        status: 'PLANNED',
        realTradingLocked: true,
        paperOnly: true,
        tradingExecuted: 0,
      },
    ]);

    writeJsonl(exitPolicyPath, [
      {
        policy: 'TIME_EXIT_10M',
        supported: true,
        candidatesWithData: 4,
        avgSimulatedPL: 1.8,
      },
    ]);
    writeJsonl(timingReportPath, [{ window: 'WAIT_10M' }]);
    writeJsonl(realVsFakePath, [{ clusterRisk: 'CLEAN', priceChangePct: 0 }]);

    fs.mkdirSync(path.dirname(liveShadowStatePath), { recursive: true });
    fs.writeFileSync(liveShadowStatePath, JSON.stringify({
      sessionId: 's1',
      startedAt: '2026-10-29T23:00:00.000Z',
      lastCycleAt: '2026-10-30T00:15:00.000Z',
      cycleCount: 10,
      bankrolls: {
        20: {
          bankroll: 20,
          openPositions: [
            {
              contract: 'A',
              symbol: 'AAA',
              bankroll: 20,
              openedAt: '2026-10-30T00:10:00.000Z',
              lane: 'NO_BM_INTERNAL_BROAD',
              sourceCycle: 'cycle-2026-10-30-000100',
              entryRipperScore: 92,
              positionSizeUsd: 5,
              status: 'OPEN',
              riskLabels: { holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN', botRisk: 'CLEAN', launchAgeBucket: 'PRIME_WINDOW', liquidityQuality: 'GOOD' },
            },
          ],
          closedPositions: [
            {
              contract: 'OLD1',
              symbol: 'OLD1',
              bankroll: 20,
              openedAt: '2026-10-29T23:10:00.000Z',
              closedAt: '2026-10-30T00:05:00.000Z',
              lane: 'NO_BM_INTERNAL_BROAD',
              sourceCycle: 'cycle-old',
              entryRipperScore: 80,
              positionSizeUsd: 5,
              status: 'CLOSED',
              valuationUsable: true,
              pnlUsd: 1.25,
              pnlPct: 25,
              riskLabels: { holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN', botRisk: 'CLEAN', launchAgeBucket: 'PRIME_WINDOW', liquidityQuality: 'GOOD' },
            },
          ],
          totalWouldBuys: 1,
          totalWouldSells: 1,
          dailyBuyCount: 1,
          dailyLossUsd: 0,
          dailyResetDate: '2026-10-30',
          killSwitchActive: false,
          skippedByRiskLimit: 0,
        },
        50: {
          bankroll: 50,
          openPositions: [],
          closedPositions: [
            {
              contract: 'OLD2',
              symbol: 'OLD2',
              bankroll: 50,
              openedAt: '2026-10-29T23:10:00.000Z',
              closedAt: '2026-10-30T00:06:00.000Z',
              lane: 'NO_BM_BEST_VLR',
              sourceCycle: 'cycle-old',
              entryRipperScore: 81,
              positionSizeUsd: 10,
              status: 'CLOSED',
              valuationUsable: true,
              pnlUsd: -2,
              pnlPct: -20,
              riskLabels: { holderRisk: 'UNKNOWN', clusterRisk: 'UNKNOWN', botRisk: 'CLEAN', launchAgeBucket: 'PRIME_WINDOW', liquidityQuality: 'GOOD' },
            },
          ],
          totalWouldBuys: 1,
          totalWouldSells: 1,
          dailyBuyCount: 1,
          dailyLossUsd: 2,
          dailyResetDate: '2026-10-30',
          killSwitchActive: true,
          killSwitchReason: 'daily loss hit',
          skippedByRiskLimit: 1,
        },
        100: {
          bankroll: 100,
          openPositions: [],
          closedPositions: [],
          totalWouldBuys: 0,
          totalWouldSells: 0,
          dailyBuyCount: 0,
          dailyLossUsd: 0,
          dailyResetDate: '2026-10-30',
          killSwitchActive: false,
          skippedByRiskLimit: 0,
        },
      },
      liveShadowOnly: true,
      realTrading: false,
      noWallet: true,
      noSwap: true,
      noSigning: true,
      tradingExecuted: 0,
    }, null, 2), 'utf-8');

    writeJsonl(researchEventsPath, [
      {
        type: 'RESEARCH_WOULD_BUY',
        ts: '2026-10-30T00:00:00.000Z',
        contract: 'A',
        symbol: 'AAA',
        lane: 'NO_BM_INTERNAL_BROAD',
        sourceCycle: 'cycle-2026-10-30-000100',
        productionGateApproved: true,
        launchAgeBucket: 'PRIME_WINDOW',
      },
      {
        type: 'RESEARCH_WOULD_SELL',
        ts: '2026-10-30T00:05:00.000Z',
        contract: 'A',
        symbol: 'AAA',
        lane: 'NO_BM_INTERNAL_BROAD',
        sourceCycle: 'cycle-2026-10-30-000100',
        productionGateApproved: true,
        launchAgeBucket: 'PRIME_WINDOW',
        valuationUsable: true,
        pnlPct: 12,
        pnlUsd: 1.2,
      },
      {
        type: 'RESEARCH_WOULD_BUY',
        ts: '2026-10-30T00:01:00.000Z',
        contract: 'B',
        symbol: 'BBB',
        lane: 'NO_BM_BEST_VLR',
        sourceCycle: 'cycle-2026-10-30-000100',
        productionGateApproved: false,
        launchAgeBucket: 'PRIME_WINDOW',
      },
      {
        type: 'RESEARCH_WOULD_SELL',
        ts: '2026-10-30T00:06:00.000Z',
        contract: 'B',
        symbol: 'BBB',
        lane: 'NO_BM_BEST_VLR',
        sourceCycle: 'cycle-2026-10-30-000100',
        productionGateApproved: false,
        launchAgeBucket: 'PRIME_WINDOW',
        valuationUsable: true,
        pnlPct: -5,
        pnlUsd: -0.5,
      },
    ]);

    fs.writeFileSync(researchStatePath, JSON.stringify({
      sessionId: 'r1',
      startedAt: '2026-10-29T23:00:00.000Z',
      openPositions: [],
      closedPositions: [],
      lastEventAt: '2026-10-30T00:06:00.000Z',
      researchOnly: true,
      notABuySignal: true,
      realTrading: false,
      noWallet: true,
      noSwap: true,
      noSigning: true,
      tradingExecuted: 0,
    }, null, 2), 'utf-8');

    fs.writeFileSync(brainMemoryPath, JSON.stringify({
      version: 2,
      generatedAt: '2026-10-30T00:18:00.000Z',
      eventsPath: researchEventsPath,
      totalProfiles: 2,
      profiles: {
        p1: { key: 'p1', lane: 'NO_BM_INTERNAL_BROAD', productionGateApproved: true, launchAgeBucket: 'PRIME_WINDOW', m5Band: 'M5_NEUTRAL', liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', ripperScoreBand: 'SCORE_80_89', sampleSize: 1, valuedClosed: 1, unvaluedClosed: 0, wins: 1, losses: 0, flats: 0, medianPnlPct: 12, cappedAveragePnlPct: 12, redLossRate: 0, bestTrade: null, worstTrade: null, lastUpdated: '2026-10-30T00:18:00.000Z', confidenceTier: 'TOO_SMALL', policyStatus: 'PROMOTE', killedAt: null, killReason: null, priorStatus: null, recoveryState: null },
        p2: { key: 'p2', lane: 'NO_BM_BEST_VLR', productionGateApproved: false, launchAgeBucket: 'PRIME_WINDOW', m5Band: 'M5_NEUTRAL', liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_GTE_2', ripperScoreBand: 'SCORE_70_79', sampleSize: 1, valuedClosed: 1, unvaluedClosed: 0, wins: 0, losses: 1, flats: 0, medianPnlPct: -5, cappedAveragePnlPct: -5, redLossRate: 1, bestTrade: null, worstTrade: null, lastUpdated: '2026-10-30T00:18:00.000Z', confidenceTier: 'TOO_SMALL', policyStatus: 'KILL', killedAt: '2026-10-30T00:18:00.000Z', killReason: 'bad', priorStatus: 'WATCH', recoveryState: 'KILLED' },
      },
      totalGlobalGroups: 1,
      globalGroups: {
        g1: { key: 'lane:NO_BM_BEST_VLR', dimension: 'lane', value: 'NO_BM_BEST_VLR', buys: 1, valuedClosed: 1, unvaluedClosed: 0, wins: 0, losses: 1, flats: 0, medianPnlPct: -5, cappedAveragePnlPct: -5, redLossRate: 1, bestTrade: null, worstTrade: null, lastUpdated: '2026-10-30T00:18:00.000Z', confidenceTier: 'TOO_SMALL', policyStatus: 'KILL', killedAt: '2026-10-30T00:18:00.000Z', killReason: 'bad', priorStatus: 'WATCH', recoveryState: 'KILLED' },
      },
      realTrading: false,
      readyForRealTrading: false,
      noWallet: true,
      noSwap: true,
      noSigning: true,
      paperOnly: true,
      researchOnly: true,
      unknownStaysUnknown: true,
      tradingExecuted: 0,
    }, null, 2), 'utf-8');

    fs.mkdirSync(learningLockPath, { recursive: true });
    fs.writeFileSync(path.join(learningLockPath, 'pid'), '12345\n', 'utf-8');
    fs.mkdirSync(liveShadowLockPath, { recursive: true });

    const result = runRipperOpsStatus({
      cyclesDir,
      intentsPath,
      timingReportPath,
      exitPolicyPath,
      realVsFakePath,
      liveShadowStatePath,
      researchEventsPath,
      researchStatePath,
      brainMemoryPath,
      learningLockPath,
      liveShadowLockPath,
      generatedAt: '2026-10-30T00:21:00.000Z',
      nowMs: Date.parse('2026-10-30T00:21:00.000Z'),
      freshnessMinutes: 20,
    });

    expect(result.runningNow).toBe(true);
    expect(result.runningSources.find(s => s.label === 'learning-cron')?.pid).toBe('12345');
    expect(result.latestSuccessfulCycle).toBe('2026-10-30T00:01:00Z');
    expect(result.latestSuccessfulShadowCycle).toBe('2026-10-30T00:15:00.000Z');
    expect(result.tokensDiscoveredLatestCycle).toBe(2);
    expect(result.approvedLatestCycle).toBe(1);
    expect(result.rejectedLatestCycle).toBe(1);
    expect(result.openPositions).toHaveLength(1);
    expect(result.bankrolls.find(b => b.bankroll === 20)?.todayReturnUsd).toBe(1.25);
    expect(result.bankrolls.find(b => b.bankroll === 50)?.killSwitchActive).toBe(true);
    expect(result.todaySimulatedReturnUsd).toBe(-0.75);
    expect(result.cumulativeRealizedPnlUsd).toBe(-0.75);
    expect(result.brain.autopilotDecision).toBe('PAPER_ONLY_WAIT10_FOR_HIGH_QUALITY_SUBGROUP');
    expect(result.brain.stickyKilledGroups).toBe(1);
    expect(result.leadingStrategy.lane).toBe('NO_BM_INTERNAL_BROAD');
    expect(result.feedFreshness.stale).toBe(true);
    expect(result.safety.emergencyPaperKillActive).toBe(true);
    expect(result.safety.triggered).toContain('STALE_RIPPER_CYCLE_FEED');
    expect(result.safety.triggered).toContain('PAPER_KILL_SWITCH_ACTIVE:1');
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noWallet).toBe(true);
    expect(result.noSwap).toBe(true);
    expect(result.noSigning).toBe(true);
  });

  it('renders a single operator status view', () => {
    const statePath = path.join(tmpDir, 'live-shadow-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId: 's1',
      startedAt: '2026-10-29T23:00:00.000Z',
      lastCycleAt: '2026-10-30T00:20:00.000Z',
      cycleCount: 1,
      bankrolls: {
        20: { bankroll: 20, openPositions: [], closedPositions: [], totalWouldBuys: 0, totalWouldSells: 0, dailyBuyCount: 0, dailyLossUsd: 0, dailyResetDate: '2026-10-30', killSwitchActive: false, skippedByRiskLimit: 0 },
        50: { bankroll: 50, openPositions: [], closedPositions: [], totalWouldBuys: 0, totalWouldSells: 0, dailyBuyCount: 0, dailyLossUsd: 0, dailyResetDate: '2026-10-30', killSwitchActive: false, skippedByRiskLimit: 0 },
        100: { bankroll: 100, openPositions: [], closedPositions: [], totalWouldBuys: 0, totalWouldSells: 0, dailyBuyCount: 0, dailyLossUsd: 0, dailyResetDate: '2026-10-30', killSwitchActive: false, skippedByRiskLimit: 0 },
      },
      liveShadowOnly: true,
      realTrading: false,
      noWallet: true,
      noSwap: true,
      noSigning: true,
      tradingExecuted: 0,
    }), 'utf-8');

    const rendered = renderRipperOpsStatus(runRipperOpsStatus({
      liveShadowStatePath: statePath,
      generatedAt: '2026-10-30T00:21:00.000Z',
      nowMs: Date.parse('2026-10-30T00:21:00.000Z'),
    }));

    expect(rendered).toContain('TOKEN GRAB — OPERATIONS STATUS');
    expect(rendered).toContain('OPEN SIMULATED POSITIONS');
    expect(rendered).toContain('BANKROLLS');
    expect(rendered).toContain('BRAIN / STRATEGY');
    expect(rendered).toContain('PROCESS / SAFETY');
    expect(rendered).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
});
