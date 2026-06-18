import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperWatchSignalValidation,
  renderRipperWatchSignalValidation,
} from '../src/token-grab/ripperWatchSignalValidationReport';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-val-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeJsonl(name: string, rows: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: 'C1',
    outcomeLabel: 'WINNER',
    priceChangePct: 10,
    clusterRisk: 'WATCH',
    liquidityBucket: 'LIQ_10K_30K',
    vlrBucket: 'VLR_0_5_TO_2',
    launchAgeBucket: 'PRIME_WINDOW',
    timingPath: 'ENTER_NOW',
    ...overrides,
  };
}

describe('ripperWatchSignalValidationReport', () => {
  it('groups known vs unknown liquidity', () => {
    const p = writeJsonl('mem.jsonl', [
      row({ contract: 'W1', clusterRisk: 'WATCH', liquidityBucket: 'LIQ_10K_30K', outcomeLabel: 'WINNER' }),
      row({ contract: 'W2', clusterRisk: 'WATCH', liquidityBucket: 'LIQ_UNKNOWN', outcomeLabel: 'DUMP' }),
    ]);
    const r = runRipperWatchSignalValidation({ learningMemoryPath: p, nowMs: 1 });
    const known = r.groups.find(g => g.groupName === 'WATCH + known liquidity')!;
    const unk = r.groups.find(g => g.groupName === 'WATCH + LIQ_UNKNOWN')!;
    expect(known.totalRows).toBe(1);
    expect(unk.totalRows).toBe(1);
  });

  it('builds WATCH vs CLEAN matched buckets', () => {
    const p = writeJsonl('mem.jsonl', [
      row({ contract: 'W1', clusterRisk: 'WATCH', liquidityBucket: 'LIQ_10K_30K', outcomeLabel: 'WINNER' }),
      row({ contract: 'C1', clusterRisk: 'CLEAN', liquidityBucket: 'LIQ_10K_30K', outcomeLabel: 'DUMP' }),
    ]);
    const r = runRipperWatchSignalValidation({ learningMemoryPath: p, nowMs: 1 });
    const match = r.matchedComparisons.find(m => m.dimension === 'liquidityBucket' && m.bucket === 'LIQ_10K_30K')!;
    expect(match.watchRows).toBe(1);
    expect(match.cleanRows).toBe(1);
  });

  it('computes pessimistic win5 as wins over total rows', () => {
    const p = writeJsonl('mem.jsonl', [
      row({ contract: 'W1', clusterRisk: 'WATCH', outcomeLabel: 'WINNER' }),
      row({ contract: 'W2', clusterRisk: 'WATCH', outcomeLabel: 'UNKNOWN' }),
    ]);
    const r = runRipperWatchSignalValidation({ learningMemoryPath: p, nowMs: 1 });
    const g = r.groups.find(x => x.groupName === 'WATCH + known liquidity')!;
    expect(g.observedWin5).toBeCloseTo(1);
    expect(g.pessimisticWin5).toBeCloseTo(0.5);
  });

  it('flags artifact risk when unknown buckets dominate / coverage low', () => {
    const p = writeJsonl('mem.jsonl', [
      row({ contract: 'W1', clusterRisk: 'WATCH', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', outcomeLabel: 'UNKNOWN' }),
      row({ contract: 'W2', clusterRisk: 'WATCH', liquidityBucket: 'LIQ_UNKNOWN', vlrBucket: 'VLR_UNKNOWN', outcomeLabel: 'DUMP' }),
    ]);
    const r = runRipperWatchSignalValidation({ learningMemoryPath: p, nowMs: 1 });
    const g = r.groups.find(x => x.groupName === 'WATCH + LIQ_UNKNOWN')!;
    expect(g.artifactRisk).toBe('HIGH');
  });

  it('renderer includes safety flags', () => {
    const p = writeJsonl('mem.jsonl', [row()]);
    const r = runRipperWatchSignalValidation({ learningMemoryPath: p, nowMs: 1 });
    const out = renderRipperWatchSignalValidation(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('readOnly=true');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
  });
});
