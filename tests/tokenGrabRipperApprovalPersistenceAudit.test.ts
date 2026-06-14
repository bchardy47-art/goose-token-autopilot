import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovalPersistenceAudit,
  renderRipperApprovalPersistenceAudit,
} from '../src/token-grab/ripperApprovalPersistenceAudit';

// ── Fixture helpers ───────────────────────────────────────────────────────────

interface ObsOpts {
  contract?:        string;
  capturedAt?:      string;
  buyGateDecision?: string;
  ripperScore?:     number;
  priceChangePct?:  number;
  liquidityUsd?:    number;
  volumeUsd?:       number;
  symbol?:          string;
}

function makeObs(opts: ObsOpts = {}) {
  const contract      = opts.contract      ?? 'contractA';
  const capturedAt    = opts.capturedAt    ?? '2024-01-01T10:00:00.000Z';
  const gateDecision  = opts.buyGateDecision ?? 'WATCHING';
  const normalizedSignal: Record<string, unknown> = {
    id:     contract,
    contract,
    source: 'test',
    sourceKind: 'dex',
    discoveredAt: capturedAt,
    observedAt:   capturedAt,
    confidence: 1,
    signalReasons: [],
    warnings: [],
    priceChangePct:  opts.priceChangePct ?? 0.1,
    liquidityUsd:    opts.liquidityUsd   ?? 50000,
    volumeUsd:       opts.volumeUsd      ?? 30000,
    symbol:          opts.symbol         ?? 'TST',
  };
  return {
    capturedAt,
    id: contract,
    source: 'test',
    sourceKind: 'dex',
    buyGateDecision: gateDecision,
    blockers: [],
    topReasons: [],
    warnings: [],
    ripperInput: null,
    ripperScore: opts.ripperScore ?? null,
    normalizedSignal,
    realTradingLocked: true as const,
    paperOnly: true as const,
    readOnly: true as const,
  };
}

let tmpDir: string;

function writeTmpJsonl(name: string, records: unknown[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n'));
  return p;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapa-')); });
afterEach(()  => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runRipperApprovalPersistenceAudit', () => {

  describe('safety fields', () => {
    it('result always carries safety flags', () => {
      const result = runRipperApprovalPersistenceAudit({ observationPaths: [], approvalPaths: [] });
      expect(result.reportOnly).toBe(true);
      expect(result.readOnly).toBe(true);
      expect(result.tradingExecuted).toBe(0);
      expect(result.realTradingLocked).toBe(true);
      expect(result.paperOnly).toBe(true);
    });
  });

  describe('empty inputs', () => {
    it('returns zero counts when no paths given', () => {
      const result = runRipperApprovalPersistenceAudit({ observationPaths: [], approvalPaths: [] });
      expect(result.totalObsApproved).toBe(0);
      expect(result.totalFileApproved).toBe(0);
      expect(result.matchedCount).toBe(0);
      expect(result.obsOnlyCount).toBe(0);
      expect(result.fileOnlyCount).toBe(0);
      expect(result.obsOnlyRows).toHaveLength(0);
      expect(result.fileOnlyKeys).toHaveLength(0);
    });

    it('skips missing paths without throwing', () => {
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: ['/tmp/does-not-exist-abc123.jsonl'],
        approvalPaths:    ['/tmp/does-not-exist-abc456.jsonl'],
      });
      expect(result.totalObsApproved).toBe(0);
    });
  });

  describe('all matched', () => {
    it('counts correctly when all obs approvals are also in files', () => {
      const obsFile  = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
        makeObs({ contract: 'B', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:01:00.000Z' }),
      ]);
      const appFile  = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:30.000Z' }),
        makeObs({ contract: 'B', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:01:30.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [appFile],
      });
      expect(result.totalObsApproved).toBe(2);
      expect(result.totalFileApproved).toBe(2);
      expect(result.matchedCount).toBe(2);
      expect(result.obsOnlyCount).toBe(0);
      expect(result.fileOnlyCount).toBe(0);
      expect(result.obsOnlyRows).toHaveLength(0);
      expect(result.fileOnlyKeys).toHaveLength(0);
    });
  });

  describe('obs-only (missing from files)', () => {
    it('identifies contracts approved in obs but not in any file', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'MISSING', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z', symbol: 'MIS' }),
        makeObs({ contract: 'PRESENT', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z', symbol: 'PRS' }),
      ]);
      const appFile = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'PRESENT', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:30.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [appFile],
      });
      expect(result.totalObsApproved).toBe(2);
      expect(result.totalFileApproved).toBe(1);
      expect(result.matchedCount).toBe(1);
      expect(result.obsOnlyCount).toBe(1);
      expect(result.fileOnlyCount).toBe(0);
      expect(result.obsOnlyRows).toHaveLength(1);
      expect(result.obsOnlyRows[0].contractKey).toBe('MISSING');
      expect(result.obsOnlyRows[0].symbol).toBe('MIS');
    });

    it('captures first obs approval timestamp (earliest) for obs-only rows', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'X', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:05:00.000Z' }),
        makeObs({ contract: 'X', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }), // earlier
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      expect(result.obsOnlyRows[0].firstObsApprovedAt).toBe('2024-01-01T10:00:00.000Z');
    });

    it('captures ripperScore, liquidityUsd, volumeUsd, priceChangePct from first obs approval', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({
          contract: 'SIG',
          buyGateDecision: 'BUY_APPROVED_PAPER',
          capturedAt: '2024-01-01T10:00:00.000Z',
          ripperScore: 0.87,
          liquidityUsd: 55000,
          volumeUsd: 25000,
          priceChangePct: 0.15,
        }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      const row = result.obsOnlyRows[0];
      expect(row.ripperScore).toBeCloseTo(0.87);
      expect(row.liquidityUsd).toBe(55000);
      expect(row.volumeUsd).toBe(25000);
      expect(row.priceChangePct).toBeCloseTo(0.15);
    });

    it('records sourceFile for obs-only rows', () => {
      const obsFile = writeTmpJsonl('obs-source.jsonl', [
        makeObs({ contract: 'SRC', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      expect(result.obsOnlyRows[0].sourceFile).toBe(obsFile);
    });

    it('ignores obs fixtures without BUY_APPROVED_PAPER', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'W', buyGateDecision: 'WATCHING' }),
        makeObs({ contract: 'R', buyGateDecision: 'BUY_REJECTED_PAPER' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      expect(result.totalObsApproved).toBe(0);
      expect(result.obsOnlyRows).toHaveLength(0);
    });

    it('computes nearestFileApprovalAt from all file timestamps', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'MISS', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
      ]);
      const appFile = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'OTHER1', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T09:58:00.000Z' }),
        makeObs({ contract: 'OTHER2', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:02:00.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [appFile],
      });
      // Nearest to 10:00:00 is 10:02:00 (2min away) vs 09:58:00 (2min away) — tie goes to after
      expect(result.obsOnlyRows[0].nearestFileApprovalAt).not.toBeNull();
    });

    it('sets nearestFileApprovalAt to null when no file approvals exist', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'MISS', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      expect(result.obsOnlyRows[0].nearestFileApprovalAt).toBeNull();
    });
  });

  describe('file-only (missing from obs)', () => {
    it('identifies contracts in approval files but not in obs', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'PRESENT', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ]);
      const appFile = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'PRESENT', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
        makeObs({ contract: 'FILE_ONLY', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:01:00.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [appFile],
      });
      expect(result.fileOnlyCount).toBe(1);
      expect(result.fileOnlyKeys).toContain('FILE_ONLY');
    });

    it('ignores file fixtures without BUY_APPROVED_PAPER', () => {
      const appFile = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'W', buyGateDecision: 'WATCHING' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [],
        approvalPaths:    [appFile],
      });
      expect(result.totalFileApproved).toBe(0);
      expect(result.fileOnlyKeys).toHaveLength(0);
    });

    it('deduplicates file approvals by contractKey + capturedAt', () => {
      const appFile = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'DUP', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
        makeObs({ contract: 'DUP', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [],
        approvalPaths:    [appFile],
      });
      expect(result.totalFileApproved).toBe(1);
      expect(result.fileOnlyKeys).toHaveLength(1);
    });
  });

  describe('mixed scenario', () => {
    it('handles obs-only, file-only, and matched in one run', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'MATCHED',  buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
        makeObs({ contract: 'OBS_ONLY', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:01:00.000Z' }),
      ]);
      const appFile = writeTmpJsonl('approvals.jsonl', [
        makeObs({ contract: 'MATCHED',   buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:30.000Z' }),
        makeObs({ contract: 'FILE_ONLY', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:02:00.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [appFile],
      });
      expect(result.totalObsApproved).toBe(2);
      expect(result.totalFileApproved).toBe(2);
      expect(result.matchedCount).toBe(1);
      expect(result.obsOnlyCount).toBe(1);
      expect(result.fileOnlyCount).toBe(1);
      expect(result.obsOnlyRows[0].contractKey).toBe('OBS_ONLY');
      expect(result.fileOnlyKeys).toContain('FILE_ONLY');
    });
  });

  describe('multiple obs files', () => {
    it('collects approvals across multiple obs files', () => {
      const obsFile1 = writeTmpJsonl('obs1.jsonl', [
        makeObs({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
      ]);
      const obsFile2 = writeTmpJsonl('obs2.jsonl', [
        makeObs({ contract: 'B', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:01:00.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile1, obsFile2],
        approvalPaths:    [],
      });
      expect(result.totalObsApproved).toBe(2);
      expect(result.obsOnlyCount).toBe(2);
    });
  });

  describe('obsOnlyRows ordering', () => {
    it('sorts obs-only rows by firstObsApprovedAt ascending', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'LATER',  buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:05:00.000Z' }),
        makeObs({ contract: 'FIRST',  buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:00:00.000Z' }),
        makeObs({ contract: 'MIDDLE', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: '2024-01-01T10:02:00.000Z' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      const keys = result.obsOnlyRows.map(r => r.contractKey);
      expect(keys).toEqual(['FIRST', 'MIDDLE', 'LATER']);
    });
  });

  describe('contractKeyShort', () => {
    it('truncates long contract keys in shortKey field', () => {
      const longKey = 'A'.repeat(20);
      const obsFile  = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: longKey, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      expect(result.obsOnlyRows[0].contractKeyShort).toMatch(/…$/);
      expect(result.obsOnlyRows[0].contractKeyShort.length).toBeLessThanOrEqual(15);
    });

    it('does not truncate short contract keys', () => {
      const obsFile = writeTmpJsonl('obs.jsonl', [
        makeObs({ contract: 'SHORT', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      ]);
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      expect(result.obsOnlyRows[0].contractKeyShort).toBe('SHORT');
    });
  });
});

// ── Renderer tests ─────────────────────────────────────────────────────────────

describe('renderRipperApprovalPersistenceAudit', () => {
  it('renders safety header and footer', () => {
    const result = runRipperApprovalPersistenceAudit({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalPersistenceAudit(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('renders summary counts', () => {
    const result = runRipperApprovalPersistenceAudit({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalPersistenceAudit(result);
    expect(output).toContain('Obs-approved contracts');
    expect(output).toContain('File-approved contracts');
    expect(output).toContain('Matched (both)');
    expect(output).toContain('Obs-only (MISSING file)');
    expect(output).toContain('File-only (MISSING obs)');
  });

  it('renders "none" message when no obs-only rows', () => {
    const result = runRipperApprovalPersistenceAudit({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalPersistenceAudit(result);
    expect(output).toContain('(none — all obs approvals have matching approval file entries)');
  });

  it('renders "none" message when no file-only keys', () => {
    const result = runRipperApprovalPersistenceAudit({ observationPaths: [], approvalPaths: [] });
    const output = renderRipperApprovalPersistenceAudit(result);
    expect(output).toContain('(none — all file approvals have matching observation fixture entries)');
  });

  it('renders obs-only rows table when rows exist', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rapa-r-'));
    try {
      const obsFile = path.join(tmpDir2, 'obs.jsonl');
      fs.writeFileSync(obsFile, JSON.stringify(
        makeObs({ contract: 'RENDER_TEST', buyGateDecision: 'BUY_APPROVED_PAPER', symbol: 'RND', ripperScore: 0.75 })
      ));
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [obsFile],
        approvalPaths:    [],
      });
      const output = renderRipperApprovalPersistenceAudit(result);
      expect(output).toContain('$RND');
      expect(output).toContain('OBS-APPROVED BUT MISSING FROM APPROVAL FILES');
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('renders file-only keys when present', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rapa-f-'));
    try {
      const appFile = path.join(tmpDir2, 'app.jsonl');
      fs.writeFileSync(appFile, JSON.stringify(
        makeObs({ contract: 'FILEONLY_KEY', buyGateDecision: 'BUY_APPROVED_PAPER' })
      ));
      const result = runRipperApprovalPersistenceAudit({
        observationPaths: [],
        approvalPaths:    [appFile],
      });
      const output = renderRipperApprovalPersistenceAudit(result);
      expect(output).toContain('FILEONLY_KEY');
      expect(output).toContain('FILE-APPROVED BUT MISSING FROM OBSERVATION FIXTURES');
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
