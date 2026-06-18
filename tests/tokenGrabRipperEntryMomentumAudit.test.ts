import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runEntryMomentumAudit,
  renderEntryMomentumAudit,
} from '../src/token-grab/ripperEntryMomentumAudit';
import { buildFixture } from '../src/token-grab/liveFixtureCapture';
import type { RipperEarSignal } from '../src/token-grab/ripperEars';
import { DEFAULT_RIPPER_CONFIG } from '../src/token-grab/dexRipperEngine';

// ── Test helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;
let cyclesDir: string;

beforeEach(() => {
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'em-audit-'));
  cyclesDir = path.join(tmpDir, 'cycles');
  fs.mkdirSync(cyclesDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCycleJsonl(slug: string, rows: unknown[]): string {
  const filePath = path.join(cyclesDir, `cycle-${slug}.jsonl`);
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function makeSignal(overrides: Partial<RipperEarSignal> = {}): RipperEarSignal {
  return {
    id: 'test:CONTRACT_A:2026-06-18-1000',
    source: 'dex-watch-run',
    sourceKind: 'DEX_NEW_POOL',
    contract: 'CONTRACT_A',
    symbol: 'TKN',
    discoveredAt: '2026-06-18T09:55:00.000Z',
    observedAt: '2026-06-18T10:00:00.000Z',
    confidence: 'MEDIUM',
    signalReasons: [],
    warnings: [],
    liquidityUsd: 15000,
    priceChangePct: 5.5,
    ...overrides,
  };
}

// ── Tests: buildFixture adds entryMomentum fields ─────────────────────────────

describe('buildFixture — entryMomentum fields', () => {
  it('always adds entryMomentumPct=null (no independent capture-time field)', () => {
    const signal = makeSignal({ priceChangePct: 25 }); // >20 pct (outcome-correlated)
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, Date.now());
    expect(fixture.entryMomentumPct).toBeNull();
  });

  it('does not copy priceChangePct into entryMomentumPct', () => {
    const signal = makeSignal({ priceChangePct: 30 });
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, Date.now());
    expect(fixture.entryMomentumPct).toBeNull();
    expect(fixture.entryMomentumPct).not.toBe(signal.priceChangePct);
  });

  it('sets entryMomentumSource=UNAVAILABLE', () => {
    const fixture = buildFixture(makeSignal(), DEFAULT_RIPPER_CONFIG, Date.now());
    expect(fixture.entryMomentumSource).toBe('UNAVAILABLE');
  });

  it('sets entryMomentumWindowLabel=UNAVAILABLE', () => {
    const fixture = buildFixture(makeSignal(), DEFAULT_RIPPER_CONFIG, Date.now());
    expect(fixture.entryMomentumWindowLabel).toBe('UNAVAILABLE');
  });

  it('sets entryMomentumCapturedAt to the fixture capturedAt timestamp', () => {
    const nowMs = Date.parse('2026-06-18T10:00:00.000Z');
    const fixture = buildFixture(makeSignal(), DEFAULT_RIPPER_CONFIG, nowMs);
    expect(fixture.entryMomentumCapturedAt).toBe(fixture.capturedAt);
    expect(fixture.entryMomentumCapturedAt).toBe('2026-06-18T10:00:00.000Z');
  });

  it('preserves existing priceChangePct on signal (not removed)', () => {
    const signal = makeSignal({ priceChangePct: 22 });
    const fixture = buildFixture(signal, DEFAULT_RIPPER_CONFIG, Date.now());
    expect(fixture.normalizedSignal.priceChangePct).toBe(22);
    expect(fixture.ripperInput?.priceChangePct).toBe(22);
  });

  it('does not add wallet, signing, or swap fields', () => {
    const fixture = buildFixture(makeSignal(), DEFAULT_RIPPER_CONFIG, Date.now()) as Record<string, unknown>;
    expect(fixture['wallet']).toBeUndefined();
    expect(fixture['swap']).toBeUndefined();
    expect(fixture['sign']).toBeUndefined();
    expect(fixture['realTrade']).toBeUndefined();
  });

  it('preserves safety fields', () => {
    const fixture = buildFixture(makeSignal(), DEFAULT_RIPPER_CONFIG, Date.now());
    expect(fixture.realTradingLocked).toBe(true);
    expect(fixture.paperOnly).toBe(true);
    expect(fixture.readOnly).toBe(true);
  });
});

// ── Tests: runEntryMomentumAudit ──────────────────────────────────────────────

describe('runEntryMomentumAudit — safety flags', () => {
  it('always returns safety flags', () => {
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });
});

describe('runEntryMomentumAudit — empty state', () => {
  it('returns zeros when no cycle files exist', () => {
    const r = runEntryMomentumAudit({ cyclesDir: path.join(tmpDir, 'nonexistent') });
    expect(r.cycleFilesRead).toBe(0);
    expect(r.totalRows).toBe(0);
    expect(r.rowsWithField).toBe(0);
    expect(r.rowsWithNonNull).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('warns when no cycle files found', () => {
    const r = runEntryMomentumAudit({ cyclesDir: path.join(tmpDir, 'nonexistent') });
    expect(r.warnings.some(w => w.includes('No cycle JSONL'))).toBe(true);
  });
});

describe('runEntryMomentumAudit — UNAVAILABLE rows', () => {
  it('counts rows where entryMomentumPct is null as rowsWithField but not rowsWithNonNull', () => {
    makeCycleJsonl('2026-06-18-100000', [
      { entryMomentumPct: null, entryMomentumSource: 'UNAVAILABLE', entryMomentumWindowLabel: 'UNAVAILABLE' },
      { entryMomentumPct: null, entryMomentumSource: 'UNAVAILABLE', entryMomentumWindowLabel: 'UNAVAILABLE' },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.totalRows).toBe(2);
    expect(r.rowsWithField).toBe(2);
    expect(r.rowsWithNonNull).toBe(0);
    expect(r.rowsMissing).toBe(0);
  });

  it('warns when all rows have null entryMomentumPct', () => {
    makeCycleJsonl('2026-06-18-100000', [
      { entryMomentumPct: null, entryMomentumSource: 'UNAVAILABLE' },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.warnings.some(w => w.includes('null/missing on ALL rows'))).toBe(true);
  });

  it('warns about UNAVAILABLE source and how to fix it', () => {
    makeCycleJsonl('2026-06-18-100000', [
      { entryMomentumPct: null, entryMomentumSource: 'UNAVAILABLE', entryMomentumWindowLabel: 'UNAVAILABLE' },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.warnings.some(w => w.includes('UNAVAILABLE'))).toBe(true);
  });

  it('counts UNAVAILABLE in sourcesSeen', () => {
    makeCycleJsonl('2026-06-18-100000', [
      { entryMomentumSource: 'UNAVAILABLE', entryMomentumWindowLabel: 'UNAVAILABLE' },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.sourcesSeen['UNAVAILABLE']).toBe(1);
    expect(r.windowLabelsSeen['UNAVAILABLE']).toBe(1);
  });
});

describe('runEntryMomentumAudit — valid momentum rows', () => {
  it('counts rows with non-null entryMomentumPct', () => {
    makeCycleJsonl('2026-06-18-100000', [
      { entryMomentumPct: 12.5, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5' },
      { entryMomentumPct: null, entryMomentumSource: 'UNAVAILABLE', entryMomentumWindowLabel: 'UNAVAILABLE' },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.rowsWithNonNull).toBe(1);
    expect(r.sourcesSeen['DEX_SCREENER_M5']).toBe(1);
    expect(r.windowLabelsSeen['M5']).toBe(1);
  });
});

describe('runEntryMomentumAudit — only reads latest by default', () => {
  it('reads only the latest cycle JSONL file by default', () => {
    makeCycleJsonl('2026-06-18-090000', [{ entryMomentumPct: null }]);
    makeCycleJsonl('2026-06-18-100000', [{ entryMomentumPct: null }, { entryMomentumPct: null }]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.cycleFilesRead).toBe(1);
    expect(r.totalRows).toBe(2); // only the latest file
  });

  it('reads all cycles when allCycles=true', () => {
    makeCycleJsonl('2026-06-18-090000', [{ entryMomentumPct: null }]);
    makeCycleJsonl('2026-06-18-100000', [{ entryMomentumPct: null }, { entryMomentumPct: null }]);
    const r = runEntryMomentumAudit({ cyclesDir, allCycles: true });
    expect(r.cycleFilesRead).toBe(2);
    expect(r.totalRows).toBe(3);
  });
});

describe('runEntryMomentumAudit — sample rows', () => {
  it('includes sample rows with expected fields', () => {
    makeCycleJsonl('2026-06-18-100000', [
      {
        capturedAt: '2026-06-18T10:00:00.000Z',
        normalizedSignal: { contract: 'CONTRACT_A', symbol: 'TKN' },
        entryMomentumPct: null,
        entryMomentumSource: 'UNAVAILABLE',
        entryMomentumWindowLabel: 'UNAVAILABLE',
      },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    expect(r.sampleRows.length).toBe(1);
    expect(r.sampleRows[0].contract).toBe('CONTRACT_A');
    expect(r.sampleRows[0].symbol).toBe('TKN');
    expect(r.sampleRows[0].entryMomentumPct).toBeNull();
    expect(r.sampleRows[0].entryMomentumSource).toBe('UNAVAILABLE');
  });
});

// ── Tests: renderEntryMomentumAudit ──────────────────────────────────────────

describe('renderEntryMomentumAudit', () => {
  it('contains all 6 section headers', () => {
    const r = runEntryMomentumAudit({ cyclesDir });
    const rendered = renderEntryMomentumAudit(r);
    expect(rendered).toContain('SECTION 1 — COVERAGE SUMMARY');
    expect(rendered).toContain('SECTION 2 — SOURCES SEEN');
    expect(rendered).toContain('SECTION 3 — WINDOW LABELS SEEN');
    expect(rendered).toContain('SECTION 4 — SAMPLE ROWS');
    expect(rendered).toContain('SECTION 5 — WARNINGS');
    expect(rendered).toContain('SECTION 6 — SAFETY');
  });

  it('shows safety footer text', () => {
    const r = runEntryMomentumAudit({ cyclesDir });
    const rendered = renderEntryMomentumAudit(r);
    expect(rendered).toContain('REPORT_ONLY=true');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(rendered).toContain('entryMomentumPct MUST NOT be used to approve buys');
  });

  it('shows UNAVAILABLE warning when source is UNAVAILABLE', () => {
    makeCycleJsonl('2026-06-18-100000', [
      { entryMomentumPct: null, entryMomentumSource: 'UNAVAILABLE' },
    ]);
    const r = runEntryMomentumAudit({ cyclesDir });
    const rendered = renderEntryMomentumAudit(r);
    expect(rendered).toContain('UNAVAILABLE');
  });
});
