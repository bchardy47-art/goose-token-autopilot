// LIVE_SHADOW_ONLY=true  REAL_TRADING=false  NO_WALLET  NO_SWAP  NO_SIGNING  DO_NOT_ENABLE_REAL_TRADING

import { describe, it, expect, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  runLiveShadowCycle, renderLiveShadowCycleSummary,
  buildLiveShadowDiagnosticRecord,
  type LiveShadowDiagnosticRecord, type LiveShadowCandidateDiagnostic,
} from '../src/token-grab/liveShadow';
import { runLiveShadowDiagnostic, renderLiveShadowDiagnostic } from '../src/token-grab/liveShadowDiagnostic';

const NOW_MS = new Date('2026-07-01T12:00:00Z').getTime();

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmpDir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-diag-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Prime-window candidates that score BUY_APPROVED_PAPER (mirrors the existing live-shadow fixture). */
function writeFeed(dir: string, contracts: string[]): string {
  const filePath = path.join(dir, 'feed.json');
  fs.writeFileSync(filePath, JSON.stringify({
    generatedAt: new Date(NOW_MS).toISOString(),
    candidateCount: contracts.length,
    candidates: contracts.map(contract => ({
      tier: 'WATCH', contract, symbol: contract.slice(0, 4),
      observedAt: new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      priceChangePct: 35, liquidityChangePct: 10, volumeLiquidityRatio: 0.6,
      confidence: 'MEDIUM', reasons: [], missingSafetySignals: [],
    })),
  }, null, 2));
  return filePath;
}

// ── Per-candidate reject diagnostics on the cycle result ────────────────────────────────────

describe('runLiveShadowCycle per-candidate reject diagnostics', () => {
  it('produces a diagnostic per candidate with the required fields; UNKNOWN cluster stays UNKNOWN', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, ['GoodToken1111111111111111111111111111111111']);
    const r = runLiveShadowCycle({ feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });

    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    for (const k of ['symbol', 'contract', 'decision', 'rejectReasons', 'm5Band', 'liquidityBucket', 'vlrBucket', 'ripperScoreBand', 'clusterRisk', 'buyGateDecision', 'matchesNoBmResearch', 'matchesBestSubgroup'] as const) {
      expect(d).toHaveProperty(k);
    }
    // UNKNOWN cluster (no BubbleMaps) is carried verbatim — never CLEAN.
    expect(d.clusterRisk).toBe('UNKNOWN');
    expect(d.clusterRisk).not.toBe('CLEAN');
    expect(JSON.stringify(r.diagnostics)).not.toContain('"CLEAN"');
    // vlr 0.6 → best subgroup VLR_0_5_TO_2.
    expect(d.vlrBucket).toBe('VLR_0_5_TO_2');
    expect(d.matchesBestSubgroup).toBe(true);
  });

  it('a qualifying approved candidate is READY; render shows candidate diagnostics + gate explanation', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, ['GoodToken1111111111111111111111111111111111']);
    const r = runLiveShadowCycle({ feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(r.approvedCount).toBe(1);
    expect(r.diagnostics[0]!.decision).toBe('READY');
    const txt = renderLiveShadowCycleSummary(r);
    expect(txt).toContain('CANDIDATE DIAGNOSTICS');
    expect(txt).toContain('[READY');
    expect(txt).toContain('bestSubgroup(VLR_0_5_TO_2)=YES');
    expect(txt).toMatch(/Production buy gate approved/);
  });

  it('enforces risk limits — the 3rd concurrent candidate is BLOCKED by the $20 open-position cap', () => {
    const dir = tmpDir();
    // $20 tier openPositionCap=2; three qualifying candidates in one cycle → 3rd blocked at the reference tier.
    const feedPath = writeFeed(dir, [
      'AToken111111111111111111111111111111111111A',
      'BToken222222222222222222222222222222222222B',
      'CToken333333333333333333333333333333333333C',
    ]);
    const r = runLiveShadowCycle({ feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    const blocked = r.diagnostics.filter(d => d.decision === 'BLOCKED');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.some(d => d.rejectReasons.some(x => /RISK_LIMIT/.test(x) && /open position cap/.test(x)))).toBe(true);
    // The $20 bankroll actually skipped by risk limit.
    const b20 = r.bankrollSummaries.find(b => b.bankroll === 20)!;
    expect(b20.skippedByRiskLimit).toBeGreaterThanOrEqual(1);
  });

  it('writes ONLY live-shadow files (state, events, diagnostics) when diagnosticsPath is set', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, ['GoodToken1111111111111111111111111111111111']);
    runLiveShadowCycle({
      feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'),
      diagnosticsPath: path.join(dir, 'diagnostics.jsonl'), nowMs: NOW_MS,
    });
    expect(fs.readdirSync(dir).sort()).toEqual(['diagnostics.jsonl', 'events.jsonl', 'feed.json', 'state.json'].sort());
    // The diagnostics file is JSONL with a per-cycle record carrying safety flags.
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'diagnostics.jsonl'), 'utf-8').trim()) as LiveShadowDiagnosticRecord;
    expect(rec.realTrading).toBe(false);
    expect(rec.liveShadowOnly).toBe(true);
    expect(rec.unknownNeverClean).toBe(true);
  });

  it('does NOT write a diagnostics file when diagnosticsPath is omitted (default contract preserved)', () => {
    const dir = tmpDir();
    const feedPath = writeFeed(dir, ['GoodToken1111111111111111111111111111111111']);
    runLiveShadowCycle({ feedPath, statePath: path.join(dir, 'state.json'), eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    expect(fs.readdirSync(dir).sort()).toEqual(['events.jsonl', 'feed.json', 'state.json'].sort());
  });
});

// ── Diagnostic record builder ───────────────────────────────────────────────────────────────

describe('buildLiveShadowDiagnosticRecord', () => {
  function diag(o: Partial<LiveShadowCandidateDiagnostic>): LiveShadowCandidateDiagnostic {
    return {
      symbol: 'S', contract: 'C', decision: 'IGNORED', rejectReasons: [],
      m5Band: '-5 to +5', liquidityBucket: 'GOOD', vlrBucket: 'VLR_0_5_TO_2', ripperScoreBand: 'SCORE_80_89',
      ripperScore: 85, clusterRisk: 'UNKNOWN', buyGateDecision: 'BUY_REJECTED',
      matchesNoBmResearch: true, matchesBestSubgroup: true, ...o,
    };
  }
  it('tallies decisions, ignored/blocked reasons, and top missing condition', () => {
    const diagnostics = [
      diag({ decision: 'IGNORED', rejectReasons: ['too early (2m) — wait for prime window'] }),
      diag({ decision: 'IGNORED', rejectReasons: ['too early (2m) — wait for prime window'] }),
      diag({ decision: 'BLOCKED', rejectReasons: ['RISK_LIMIT: open position cap reached (2/2)'] }),
      diag({ decision: 'READY',   rejectReasons: [] }),
    ];
    const rec = buildLiveShadowDiagnosticRecord('t', 'feed.json', diagnostics, 1, 'ok');
    expect(rec.decisionCounts).toEqual({ IGNORED: 2, WATCH: 0, BLOCKED: 1, READY: 1 });
    expect(rec.ignoredByReason['too early (2m) — wait for prime window']).toBe(2);
    expect(rec.blockedByReason['RISK_LIMIT: open position cap reached (2/2)']).toBe(1);
    expect(rec.topMissingCondition).toBe('too early (2m) — wait for prime window');
    expect(rec.readyCount).toBe(1);
    expect(rec.realTrading).toBe(false);
  });
});

// ── Diagnostic report (last N cycles) ───────────────────────────────────────────────────────

describe('runLiveShadowDiagnostic report', () => {
  function record(o: Partial<LiveShadowDiagnosticRecord>): LiveShadowDiagnosticRecord {
    return {
      schemaVersion: 1, ts: 't', feedPath: 'f', totalCandidates: 0,
      decisionCounts: { IGNORED: 0, WATCH: 0, BLOCKED: 0, READY: 0 },
      ignoredByReason: {}, blockedByReason: {}, missingConditionTally: {},
      readyCount: 0, wouldBuyCount: 0, approvedGateCount: 0, approvedGateExplain: '',
      matchesNoBmResearchCount: 0, matchesBestSubgroupCount: 0, topMissingCondition: null,
      liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, unknownNeverClean: true,
      ...o,
    };
  }

  it('handles an empty diagnostics log cleanly, REAL_TRADING=false', () => {
    const r = runLiveShadowDiagnostic({ _records: [] });
    expect(r.cyclesSummarized).toBe(0);
    expect(r.totalCandidates).toBe(0);
    expect(r.READY_FOR_REAL_TRADING).toBe(false);
    expect(r.REAL_TRADING).toBe(false);
    expect(() => renderLiveShadowDiagnostic(r)).not.toThrow();
  });

  it('summarizes last N cycles: total candidates, ignored/blocked by reason, ready/would-buy, top missing', () => {
    const recs = [
      record({ ts: 'c1', totalCandidates: 5, decisionCounts: { IGNORED: 3, WATCH: 1, BLOCKED: 0, READY: 1 }, readyCount: 1, wouldBuyCount: 1, ignoredByReason: { M5_NOT_IN_FAMILY: 3 }, missingConditionTally: { M5_NOT_IN_FAMILY: 3 } }),
      record({ ts: 'c2', totalCandidates: 4, decisionCounts: { IGNORED: 1, WATCH: 0, BLOCKED: 2, READY: 1 }, readyCount: 1, wouldBuyCount: 1, blockedByReason: { 'RISK_LIMIT: open position cap': 2 }, ignoredByReason: { M5_NOT_IN_FAMILY: 1 }, missingConditionTally: { M5_NOT_IN_FAMILY: 4, 'RISK_LIMIT: open position cap': 2 } }),
    ];
    const r = runLiveShadowDiagnostic({ _records: recs, lastN: 20 });
    expect(r.cyclesSummarized).toBe(2);
    expect(r.totalCandidates).toBe(9);
    expect(r.decisionCounts).toEqual({ IGNORED: 4, WATCH: 1, BLOCKED: 2, READY: 2 });
    expect(r.readyCount).toBe(2);
    expect(r.wouldBuyCount).toBe(2);
    expect(r.ignoredByReason['M5_NOT_IN_FAMILY']).toBe(4);
    expect(r.blockedByReason['RISK_LIMIT: open position cap']).toBe(2);
    expect(r.topMissingCondition).toBe('M5_NOT_IN_FAMILY');
  });

  it('respects lastN (only summarizes the most recent N records)', () => {
    const recs = [record({ ts: 'old', totalCandidates: 100 }), record({ ts: 'new', totalCandidates: 3 })];
    const r = runLiveShadowDiagnostic({ _records: recs, lastN: 1 });
    expect(r.cyclesSummarized).toBe(1);
    expect(r.totalCandidates).toBe(3);
    expect(r.lastCycleTs).toBe('new');
  });

  it('render includes REPORT-ONLY safety and REAL_TRADING=false, only DO_NOT_ real-trading forms', () => {
    const txt = renderLiveShadowDiagnostic(runLiveShadowDiagnostic({ _records: [record({})] }));
    expect(txt).toContain('REPORT_ONLY=true');
    expect(txt).toContain('REAL_TRADING=false');
    expect(txt).toContain('READY_FOR_REAL_TRADING=false');
    expect(txt).toContain('NO_WALLET=true');
    expect(txt).toContain('UNKNOWN_NEVER_CLEAN=true');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
  });
});

// ── Static safety guard ─────────────────────────────────────────────────────────────────────

describe('live-shadow diagnostic introduces no unsafe behavior', () => {
  const files = [
    path.resolve(__dirname, '../src/token-grab/liveShadowDiagnostic.ts'),
    path.resolve(__dirname, '../src/token-grab/liveShadow.ts'),
  ];
  it('no wallet / signing / swap-execution / private-key code', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction/i);
    }
  });
  it('the new diagnostic module never references token:auto-paper / token:paper-buy / --live', () => {
    // (liveShadow.ts documents in its header that it does NOT run those — negated mentions only.)
    const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/liveShadowDiagnostic.ts'), 'utf-8');
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
    expect(src).not.toContain('--live');
  });
  it('neither module can spawn a subprocess (no child_process import → cannot invoke any command)', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/from ['"](node:)?child_process['"]/);
      expect(src).not.toMatch(/require\(['"](node:)?child_process['"]\)/);
    }
  });
  it('no code path relabels UNKNOWN to CLEAN', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/clusterRisk\s*=\s*['"]CLEAN['"]/);
    }
  });
});
