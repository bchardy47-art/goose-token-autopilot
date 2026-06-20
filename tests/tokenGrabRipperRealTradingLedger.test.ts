import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  appendLedgerEvent,
  readLedger,
  recoverTradingState,
  getOpenPositions,
  getClosedPositions,
  getTradesToday,
  getDailyRealizedPnl,
  getDailyLoss,
  summarizeLedger,
  type LedgerEventInput,
} from '../src/token-grab/ripperRealTradingLedger';

let root: string;
let ledgerPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-test-'));
  ledgerPath = path.join(root, 'real-trading-ledger.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function at(iso: string) { return { now: () => new Date(iso) }; }

function ev(over: Partial<LedgerEventInput> & { type: LedgerEventInput['type'] }): LedgerEventInput {
  return { runId: 'run1', mode: 'live', dryRun: false, mock: false, live: true, ...over };
}

describe('Real Trading Ledger v1', () => {
  it('appends and reads events', () => {
    appendLedgerEvent(ev({ type: 'LIVE_RUN_STARTED' }), ledgerPath, at('2026-06-20T10:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_RUN_FINISHED' }), ledgerPath, at('2026-06-20T10:05:00Z'));
    const events = readLedger(ledgerPath);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('LIVE_RUN_STARTED');
    expect(events[0].eventId).toBeTruthy();
    expect(events[0].timestamp).toBe('2026-06-20T10:00:00.000Z');
  });

  it('recovers an open position', () => {
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'MINT1', symbol: 'AAA', entryPrice: 1, tokenAmount: 100, actualUsd: 50 }), ledgerPath, at('2026-06-20T10:00:00Z'));
    const open = getOpenPositions(ledgerPath);
    expect(open).toHaveLength(1);
    expect(open[0].contract).toBe('MINT1');
    expect(open[0].actualUsd).toBe(50);
  });

  it('closes a position and computes realized pnl', () => {
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'MINT1', actualUsd: 50, entryPrice: 1, tokenAmount: 100 }), ledgerPath, at('2026-06-20T10:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_CLOSED', contract: 'MINT1', actualUsd: 80, exitPrice: 1.6, reason: 'TAKE_PROFIT' }), ledgerPath, at('2026-06-20T10:10:00Z'));
    const closed = getClosedPositions(ledgerPath);
    expect(closed).toHaveLength(1);
    expect(closed[0].realizedUsd).toBe(30);     // 80 - 50
    expect(closed[0].exitReason).toBe('TAKE_PROFIT');
    expect(getOpenPositions(ledgerPath)).toHaveLength(0);
  });

  it('computes daily loss from losing trades', () => {
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M1', actualUsd: 50 }), ledgerPath, at('2026-06-20T10:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_CLOSED', contract: 'M1', actualUsd: 20 }), ledgerPath, at('2026-06-20T10:10:00Z'));
    const events = readLedger(ledgerPath);
    const ref = new Date('2026-06-20T12:00:00Z');
    expect(getDailyRealizedPnl(events, ref)).toBe(-30);
    expect(getDailyLoss(events, ref)).toBe(30);
  });

  it('counts trades today (and ignores other days)', () => {
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M1' }), ledgerPath, at('2026-06-20T10:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M2' }), ledgerPath, at('2026-06-20T11:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M3' }), ledgerPath, at('2026-06-19T11:00:00Z'));
    const events = readLedger(ledgerPath);
    expect(getTradesToday(events, new Date('2026-06-20T23:00:00Z'))).toBe(2);
  });

  it('tolerates a corrupt line', () => {
    appendLedgerEvent(ev({ type: 'LIVE_RUN_STARTED' }), ledgerPath, at('2026-06-20T10:00:00Z'));
    fs.appendFileSync(ledgerPath, 'this is not json\n');
    appendLedgerEvent(ev({ type: 'LIVE_RUN_FINISHED' }), ledgerPath, at('2026-06-20T10:05:00Z'));
    const events = readLedger(ledgerPath);
    expect(events).toHaveLength(2);   // corrupt line skipped
  });

  it('never stores a private-key-shaped wallet value', () => {
    const secret = '[' + Array.from({ length: 64 }, () => '9').join(',') + ']';
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M1', walletPublicKey: secret }), ledgerPath, at('2026-06-20T10:00:00Z'));
    const raw = fs.readFileSync(ledgerPath, 'utf-8');
    expect(raw).not.toContain('9,9,9');
    expect(raw).toContain('REDACTED');
  });

  it('summarizes the ledger', () => {
    appendLedgerEvent(ev({ type: 'LIVE_RUN_STARTED' }), ledgerPath, at('2026-06-20T10:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M1', actualUsd: 50 }), ledgerPath, at('2026-06-20T10:01:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_CLOSED', contract: 'M1', actualUsd: 70 }), ledgerPath, at('2026-06-20T10:09:00Z'));
    const s = summarizeLedger(ledgerPath, new Date('2026-06-20T12:00:00Z'));
    expect(s.totalEvents).toBe(3);
    expect(s.closedPositions).toBe(1);
    expect(s.openPositions).toBe(0);
    expect(s.dailyRealizedPnl).toBe(20);
    expect(s.byType['LIVE_POSITION_OPENED']).toBe(1);
  });

  it('recoverTradingState handles multiple open positions', () => {
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M1' }), ledgerPath, at('2026-06-20T10:00:00Z'));
    appendLedgerEvent(ev({ type: 'LIVE_POSITION_OPENED', contract: 'M2' }), ledgerPath, at('2026-06-20T10:01:00Z'));
    const { open } = recoverTradingState(readLedger(ledgerPath));
    expect(open.map(p => p.contract).sort()).toEqual(['M1', 'M2']);
  });

  it('returns empty for a missing ledger file', () => {
    expect(readLedger(path.join(root, 'nope.jsonl'))).toEqual([]);
    expect(getOpenPositions(path.join(root, 'nope.jsonl'))).toEqual([]);
  });
});
