// LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false  DO_NOT_ENABLE_REAL_TRADING

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLiveShadowCycle } from '../src/token-grab/liveShadow';
import {
  runLiveShadowValuationDiagnostic, renderLiveShadowValuationDiagnostic,
} from '../src/token-grab/liveShadowValuationDiagnostic';

const NOW_MS = new Date('2026-07-02T12:00:00Z').getTime();
const nowIso = new Date(NOW_MS).toISOString();

function cycleRow(contract: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  const m5 = (o.entryMomentumPct as number) ?? -10;
  const captured = (o.capturedAt as string) ?? nowIso;
  const priceUsd = o.priceUsd === undefined ? 0.001 : (o.priceUsd as number | null);
  const raw = priceUsd == null ? { contract } : { contract, entry: { contract, priceUsd }, final: { contract, priceUsd } };
  return {
    capturedAt: captured, ripperScore: (o.ripperScore as number) ?? 70, launchAgeBucket: 'PRIME_WINDOW',
    buyGateDecision: 'BUY_REJECTED', entryDecision: 'READY_TO_SNIPE_PAPER', entryMomentumPct: m5, topReasons: [],
    ripperInput: { contract, clusterRisk: 'UNKNOWN' }, raw,
    normalizedSignal: {
      contract, symbol: contract.slice(0, 4), liquidityUsd: 20_000, volumeLiquidityRatio: 0.6,
      priceChangePct: 35, liquidityChangePct: 10, entryPriceChangeM5: m5, observedAt: captured,
    },
  };
}
function writeCycle(cyclesDir: string, slug: string, rows: Record<string, unknown>[]): void {
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.writeFileSync(path.join(cyclesDir, `cycle-${slug}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

const dirs: string[] = [];
function tmpDir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-val-')); dirs.push(d); return d; }
function cyclesDirIn(base: string): string { const d = path.join(base, 'cycles'); fs.mkdirSync(d, { recursive: true }); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('runLiveShadowValuationDiagnostic', () => {
  it('reports a usable valuation + computed pnlPct for an open position matched in the latest cycle', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const contract = 'DiagToken11111111111111111111111111111111A';
    // Open at 0.001.
    writeCycle(cyclesDir, '2026-07-02-115500', [cycleRow(contract, { priceUsd: 0.001 })]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    // Latest cycle now at 0.0015 (+50%), still open (advance only 1 min so it does not exit).
    const t2 = NOW_MS + 60_000;
    writeCycle(cyclesDir, '2026-07-02-115600', [cycleRow(contract, { priceUsd: 0.0015, capturedAt: new Date(t2).toISOString() })]);

    const r = runLiveShadowValuationDiagnostic({ cyclesDir, statePath, nowMs: t2 });
    expect(r.openPositionCount).toBeGreaterThanOrEqual(1);
    const p = r.positions.find(x => x.bankroll === 20)!;
    expect(p.entryValuationField).toBe('priceUsd');
    expect(p.entryValuation).toBe(0.001);
    expect(p.matchedInLatestCycle).toBe(true);
    expect(p.latestValuation).toBe(0.0015);
    expect(p.valuationUsable).toBe(true);
    expect(p.pnlPct).toBeCloseTo(50, 5);
    expect(r.usableCount).toBeGreaterThanOrEqual(1);
    expect(r.READY_FOR_REAL_TRADING).toBe(false);
  });

  it('flags VALUATION_UNAVAILABLE with exact missing fields when the entry had no valuation', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const contract = 'NoValDiag111111111111111111111111111111111A';
    writeCycle(cyclesDir, '2026-07-02-115500', [cycleRow(contract, { priceUsd: null })]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    // Latest cycle still has the contract but with NO price fields.
    const t2 = NOW_MS + 60_000;
    writeCycle(cyclesDir, '2026-07-02-115600', [cycleRow(contract, { priceUsd: null, capturedAt: new Date(t2).toISOString() })]);

    const r = runLiveShadowValuationDiagnostic({ cyclesDir, statePath, nowMs: t2 });
    const p = r.positions.find(x => x.bankroll === 20)!;
    expect(p.valuationUsable).toBe(false);
    expect(p.valuationStatus).toBe('VALUATION_UNAVAILABLE');
    expect(p.pnlPct).toBeNull();
    expect(p.missingFields).toContain('entryValuation');
    // Exact valuation fields we looked for are surfaced.
    expect(p.missingFields).toEqual(expect.arrayContaining(['priceUsd']));
    expect(r.unavailableCount).toBeGreaterThanOrEqual(1);
  });

  it('renders without throwing and states READY_FOR_REAL_TRADING=false', () => {
    const dir = tmpDir(); const cyclesDir = cyclesDirIn(dir);
    writeCycle(cyclesDir, '2026-07-02-115500', [cycleRow('RenderDiag11111111111111111111111111111111A')]);
    const statePath = path.join(dir, 'state.json');
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath: path.join(dir, 'events.jsonl'), nowMs: NOW_MS });
    const r = runLiveShadowValuationDiagnostic({ cyclesDir, statePath, nowMs: NOW_MS + 60_000 });
    const txt = renderLiveShadowValuationDiagnostic(r);
    expect(txt).toContain('LIVE-SHADOW VALUATION DIAGNOSTIC');
    expect(txt).toContain('READY_FOR_REAL_TRADING=false');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
});

describe('valuation diagnostic module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/liveShadowValuationDiagnostic.ts'), 'utf-8');
  it('no wallet / signing / swap / private key', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
  });
  it('no token:auto-paper / token:paper-buy / --live', () => {
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
    expect(src).not.toContain('--live');
  });
  it('read-only — never writes files', () => {
    expect(src).not.toContain('writeFileSync');
    expect(src).not.toContain('appendFileSync');
  });
});
