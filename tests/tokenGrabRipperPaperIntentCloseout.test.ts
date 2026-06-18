import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runPaperIntentCloseout,
  renderPaperIntentCloseout,
} from '../src/token-grab/ripperPaperIntentCloseout';
import type { PaperIntentCloseoutResult } from '../src/token-grab/ripperPaperIntentCloseout';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    intentId:         'intent-aaa',
    contract:         'CONTRACT_A',
    symbol:           'TKN',
    approvedAt:       '2026-06-18T10:00:00.000Z',
    targetEntryAt:    '2026-06-18T10:10:00.000Z',
    paperEntryTiming: 'WAIT_10M',
    reason:           'HIGH_QUALITY_WAIT10_SUBGROUP',
    sourceCycle:      'cycle-aaa',
    clusterRisk:      'CLEAN',
    ripperScore:      90,
    launchAgeBucket:  'PRIME_WINDOW',
    entryDecision:    'READY_TO_SNIPE_PAPER',
    status:           'ENTRY_DUE',
    realTradingLocked: true,
    paperOnly:         true,
    tradingExecuted:   0,
    ...overrides,
  };
}

function makeObs(contract: string, capturedAt: string, pcp: number | null = 5.5) {
  const row: Record<string, unknown> = {
    capturedAt,
    source:      'paper-intent-obs',
    sourceKind:  'PAPER_INTENT_OBS',
    intentId:    'intent-aaa',
    normalizedSignal: { contract, priceChangePct: pcp },
    raw:              { contract, priceChangePct: pcp },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
  if (pcp === null) {
    (row['normalizedSignal'] as Record<string, unknown>)['priceChangePct'] = undefined;
    (row['raw'] as Record<string, unknown>)['priceChangePct'] = undefined;
  }
  return JSON.stringify(row);
}

function makeMemoryRow(contract: string, capturedAt: string, pcp: number | null = 12) {
  return JSON.stringify({
    contract,
    capturedAt,
    outcomeLabel:      'DUMP',
    priceChangePct:    pcp,
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  });
}

let tmpDir: string;
let intentsPath: string;
let memoryPath: string;
let obsDir: string;

beforeEach(() => {
  tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'closeout-test-'));
  intentsPath = path.join(tmpDir, 'paper-intents.jsonl');
  memoryPath  = path.join(tmpDir, 'learning-memory.jsonl');
  obsDir      = path.join(tmpDir, 'observations');
  fs.mkdirSync(obsDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeIntents(rows: unknown[]) {
  fs.writeFileSync(intentsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function writePaperObs(lines: string[]) {
  const obsPath = path.join(tmpDir, 'paper-intent-observations.jsonl');
  fs.writeFileSync(obsPath, lines.join('\n') + '\n', 'utf-8');
}

function writeMemory(lines: string[]) {
  fs.writeFileSync(memoryPath, lines.join('\n') + '\n', 'utf-8');
}

function writeObsFile(name: string, lines: string[]) {
  fs.writeFileSync(path.join(obsDir, name), lines.join('\n') + '\n', 'utf-8');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runPaperIntentCloseout — safety', () => {
  it('always returns safety flags', () => {
    writeIntents([]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });

  it('defaults to dryRun=true', () => {
    writeIntents([]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir });
    expect(r.dryRun).toBe(true);
  });
});

describe('runPaperIntentCloseout — empty / no ENTRY_DUE', () => {
  it('returns zeros when no intents at all', () => {
    writeIntents([]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir });
    expect(r.totalIntents).toBe(0);
    expect(r.entryDueCount).toBe(0);
    expect(r.processed).toBe(0);
    expect(r.outcomes).toEqual([]);
  });

  it('skips non-ENTRY_DUE intents (OBSERVED, EXPIRED_NO_DATA)', () => {
    writeIntents([
      makeIntent({ status: 'OBSERVED' }),
      makeIntent({ intentId: 'bbb', status: 'EXPIRED_NO_DATA' }),
    ]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir });
    expect(r.totalIntents).toBe(2);
    expect(r.entryDueCount).toBe(0);
    expect(r.processed).toBe(0);
  });
});

describe('runPaperIntentCloseout — EXPIRED_NO_DATA (past grace)', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const targetMs      = Date.parse(targetEntryAt);
  const pastGrace     = targetMs + 20 * 60_000; // 20 min after target (past 15m grace)

  it('marks intent EXPIRED_NO_DATA when past grace and no observation', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace });
    expect(r.expiredCount).toBe(1);
    expect(r.observedCount).toBe(0);
    expect(r.waitingCount).toBe(0);
    const o = r.outcomes[0];
    expect(o.resolution).toBe('EXPIRED_NO_DATA');
    expect(o.expiredReason).toBe('NO_POST_TARGET_OBSERVATION');
    expect(o.contract).toBe('CONTRACT_A');
    expect(o.symbol).toBe('TKN');
    expect(o.targetEntryAt).toBe(targetEntryAt);
  });

  it('does not mutate the file in dry-run mode', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace, dryRun: true });
    const lines = fs.readFileSync(intentsPath, 'utf-8').split('\n').filter(l => l.trim());
    const intent = JSON.parse(lines[0]);
    expect(intent.status).toBe('ENTRY_DUE');
  });

  it('mutates the file when dryRun=false', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace, dryRun: false });
    expect(r.outcomes[0].mutated).toBe(true);
    const lines = fs.readFileSync(intentsPath, 'utf-8').split('\n').filter(l => l.trim());
    const intent = JSON.parse(lines[0]);
    expect(intent.status).toBe('EXPIRED_NO_DATA');
    expect(intent.expiredReason).toBe('NO_POST_TARGET_OBSERVATION');
  });
});

describe('runPaperIntentCloseout — WAITING_FOR_OBSERVATION (within grace)', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const targetMs      = Date.parse(targetEntryAt);
  const withinGrace   = targetMs + 5 * 60_000; // 5 min after target (within 15m grace)

  it('returns WAITING_FOR_OBSERVATION when within grace and no obs', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: withinGrace });
    expect(r.waitingCount).toBe(1);
    expect(r.expiredCount).toBe(0);
    const o = r.outcomes[0];
    expect(o.resolution).toBe('WAITING_FOR_OBSERVATION');
    expect(o.waitingReason).toContain('grace');
    expect(o.mutated).toBe(false);
  });

  it('does not mutate file even with dryRun=false when waiting', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: withinGrace, dryRun: false });
    const lines = fs.readFileSync(intentsPath, 'utf-8').split('\n').filter(l => l.trim());
    expect(JSON.parse(lines[0]).status).toBe('ENTRY_DUE');
  });
});

describe('runPaperIntentCloseout — OBSERVED via paper-intent-observations.jsonl', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const afterTarget   = '2026-06-18T10:12:00.000Z';
  const pastGrace     = Date.parse(targetEntryAt) + 30 * 60_000;

  it('marks OBSERVED when paper-intent-obs has post-target row', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    writePaperObs([makeObs('CONTRACT_A', afterTarget, 8.0)]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace });
    expect(r.observedCount).toBe(1);
    expect(r.outcomes[0].resolution).toBe('OBSERVED');
    expect(r.outcomes[0].obsFoundAt).toBe(afterTarget);
  });

  it('ignores pre-target observations from paper-intent-obs', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    writePaperObs([makeObs('CONTRACT_A', '2026-06-18T10:05:00.000Z', 3.0)]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace });
    expect(r.expiredCount).toBe(1);
    expect(r.observedCount).toBe(0);
  });
});

describe('runPaperIntentCloseout — OBSERVED via learning-memory.jsonl', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const afterTarget   = '2026-06-18T10:15:00.000Z';
  const pastGrace     = Date.parse(targetEntryAt) + 30 * 60_000;

  it('marks OBSERVED when learning-memory has post-target row for contract', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    writeMemory([makeMemoryRow('CONTRACT_A', afterTarget, 22.5)]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace });
    expect(r.observedCount).toBe(1);
    expect(r.outcomes[0].obsFoundAt).toBe(afterTarget);
  });
});

describe('runPaperIntentCloseout — OBSERVED via observations/*.jsonl', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const afterTarget   = '2026-06-18T10:11:30.000Z';
  const pastGrace     = Date.parse(targetEntryAt) + 30 * 60_000;

  it('marks OBSERVED when observations dir has post-target row', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    writeObsFile('obs-batch.jsonl', [
      JSON.stringify({
        capturedAt: afterTarget,
        normalizedSignal: { contract: 'CONTRACT_A', priceChangePct: 15 },
      }),
    ]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace });
    expect(r.observedCount).toBe(1);
  });

  it('ignores .json files (not .jsonl) in observations dir', () => {
    writeIntents([makeIntent({ targetEntryAt })]);
    fs.writeFileSync(path.join(obsDir, 'run.json'), JSON.stringify({
      signals: [{ contract: 'CONTRACT_A', observedAt: afterTarget }],
    }));
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace });
    expect(r.expiredCount).toBe(1); // no .jsonl match → expired
  });
});

describe('runPaperIntentCloseout — contract filter', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const pastGrace     = Date.parse(targetEntryAt) + 30 * 60_000;

  it('filters to only the specified contract', () => {
    writeIntents([
      makeIntent({ intentId: 'aaa', contract: 'CONTRACT_A', targetEntryAt }),
      makeIntent({ intentId: 'bbb', contract: 'CONTRACT_B', targetEntryAt }),
    ]);
    const r = runPaperIntentCloseout({
      intentsPath, memoryPath, obsDir, nowMs: pastGrace,
      contract: 'CONTRACT_A',
    });
    expect(r.entryDueCount).toBe(2);
    expect(r.filtered).toBe(1);
    expect(r.processed).toBe(1);
    expect(r.outcomes[0].contract).toBe('CONTRACT_A');
  });
});

describe('runPaperIntentCloseout — maxIntents limit', () => {
  const targetEntryAt = '2026-06-18T10:10:00.000Z';
  const pastGrace     = Date.parse(targetEntryAt) + 30 * 60_000;

  it('limits processing to maxIntents', () => {
    writeIntents([
      makeIntent({ intentId: 'aaa', contract: 'A', targetEntryAt }),
      makeIntent({ intentId: 'bbb', contract: 'B', targetEntryAt }),
      makeIntent({ intentId: 'ccc', contract: 'C', targetEntryAt }),
    ]);
    const r = runPaperIntentCloseout({
      intentsPath, memoryPath, obsDir, nowMs: pastGrace,
      maxIntents: 2,
    });
    expect(r.filtered).toBe(3);
    expect(r.processed).toBe(2);
    expect(r.outcomes.length).toBe(2);
  });
});

describe('runPaperIntentCloseout — graceMinutes custom', () => {
  it('respects custom graceMinutes', () => {
    const targetEntryAt = '2026-06-18T10:10:00.000Z';
    const targetMs      = Date.parse(targetEntryAt);
    const nowMs         = targetMs + 5 * 60_000; // 5 min after target

    writeIntents([makeIntent({ targetEntryAt })]);

    // With 15m grace (default): still waiting
    const rWaiting = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs });
    expect(rWaiting.waitingCount).toBe(1);

    // With 3m grace: expired
    const rExpired = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs, graceMinutes: 3 });
    expect(rExpired.expiredCount).toBe(1);
  });
});

describe('renderPaperIntentCloseout', () => {
  it('contains all 4 section headers', () => {
    writeIntents([]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir });
    const rendered = renderPaperIntentCloseout(r);
    expect(rendered).toContain('§1 SAFETY FLAGS');
    expect(rendered).toContain('§2 INTENT SUMMARY');
    expect(rendered).toContain('§3 RESOLUTION COUNTS');
    expect(rendered).toContain('§4 OUTCOMES');
  });

  it('shows safety flags in output', () => {
    writeIntents([]);
    const r = runPaperIntentCloseout({ intentsPath, memoryPath, obsDir });
    const rendered = renderPaperIntentCloseout(r);
    expect(rendered).toContain('reportOnly=true');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('dryRun=true');
  });

  it('shows (no ENTRY_DUE intents to process) when empty', () => {
    writeIntents([]);
    const rendered = renderPaperIntentCloseout(
      runPaperIntentCloseout({ intentsPath, memoryPath, obsDir }),
    );
    expect(rendered).toContain('no ENTRY_DUE intents to process');
  });

  it('shows EXPIRED_NO_DATA outcome details', () => {
    const targetEntryAt = '2026-06-18T10:10:00.000Z';
    const pastGrace     = Date.parse(targetEntryAt) + 30 * 60_000;
    writeIntents([makeIntent({ targetEntryAt })]);
    const rendered = renderPaperIntentCloseout(
      runPaperIntentCloseout({ intentsPath, memoryPath, obsDir, nowMs: pastGrace }),
    );
    expect(rendered).toContain('EXPIRED_NO_DATA');
    expect(rendered).toContain('NO_POST_TARGET_OBSERVATION');
    expect(rendered).toContain('CONTRACT_A');
  });
});
