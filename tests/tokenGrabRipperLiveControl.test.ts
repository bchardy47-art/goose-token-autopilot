import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { runLiveControl, renderLiveControl } from '../src/token-grab/ripperLiveControl';
import { appendLedgerEvent } from '../src/token-grab/ripperRealTradingLedger';
import { CONFIRM_PHRASE, ENV } from '../src/token-grab/ripperLiveTradingConfig';

let root: string;
let ledgerPath: string;
let stopFile: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lctl-test-'));
  ledgerPath = path.join(root, 'real-trading-ledger.jsonl');
  stopFile = path.join(root, 'LIVE_STOP');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NOW = new Date('2026-06-20T12:00:00Z');
function opts(over = {}) { return { ledgerPath, stopFile, now: NOW, env: {}, ...over }; }

function seedOpenPosition() {
  appendLedgerEvent({ type: 'LIVE_POSITION_OPENED', runId: 'r', mode: 'mock', contract: 'M1', symbol: 'AAA', actualUsd: 25, entryPrice: 1, tokenAmount: 100 }, ledgerPath, { now: () => new Date('2026-06-20T11:00:00Z') });
}
function seedClosedLoss() {
  appendLedgerEvent({ type: 'LIVE_POSITION_OPENED', runId: 'r', mode: 'mock', contract: 'M2', actualUsd: 50 }, ledgerPath, { now: () => new Date('2026-06-20T10:00:00Z') });
  appendLedgerEvent({ type: 'LIVE_POSITION_CLOSED', runId: 'r', mode: 'mock', contract: 'M2', actualUsd: 30 }, ledgerPath, { now: () => new Date('2026-06-20T10:30:00Z') });
}

describe('Live Control v1', () => {
  it('reports status (locked by default)', () => {
    const { status } = runLiveControl(opts());
    expect(status.liveUnlocked).toBe(false);
    expect(status.noSecretsPrinted).toBe(true);
    expect(status.reportOnly).toBe(true);
  });

  it('lists open positions', () => {
    seedOpenPosition();
    const { status } = runLiveControl(opts());
    expect(status.openPositions).toHaveLength(1);
    expect(status.openPositions[0].contract).toBe('M1');
  });

  it('lists closed positions and ledger summary', () => {
    seedClosedLoss();
    const { status } = runLiveControl(opts());
    expect(status.closedPositions).toHaveLength(1);
    expect(status.realizedPnlToday).toBe(-20);
    expect(status.dailyLoss).toBe(20);
  });

  it('creates a stop file on request', () => {
    expect(fs.existsSync(stopFile)).toBe(false);
    const { status } = runLiveControl(opts({ createStop: true }));
    expect(fs.existsSync(stopFile)).toBe(true);
    expect(status.stopFilePresent).toBe(true);
    expect(status.actionsTaken.join(' ')).toMatch(/Created stop file/);
    expect(status.reportOnly).toBe(false);
  });

  it('clears a stop file on request', () => {
    fs.writeFileSync(stopFile, 'stop');
    const { status } = runLiveControl(opts({ clearStop: true }));
    expect(fs.existsSync(stopFile)).toBe(false);
    expect(status.stopFilePresent).toBe(false);
    expect(status.actionsTaken.join(' ')).toMatch(/Cleared stop file/);
  });

  it('doctor integration renders config doctor without secrets', () => {
    const env = {
      [ENV.ENABLED]: '1', [ENV.CONFIRM]: CONFIRM_PHRASE, [ENV.KILL_SWITCH]: '0',
      [ENV.MAX_POSITION]: '50', [ENV.MAX_DAILY_LOSS]: '100', [ENV.MAX_OPEN]: '3',
      [ENV.MAX_TRADES]: '10', [ENV.MAX_SLIPPAGE]: '150', [ENV.MIN_LIQUIDITY]: '20000',
      [ENV.RPC_URL]: 'https://rpc', [ENV.WALLET_PUBKEY]: '7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv',
      [ENV.SWAP_PROVIDER]: 'jupiter',
    };
    const { status, config } = runLiveControl(opts({ env }));
    expect(status.liveUnlocked).toBe(true);
    const text = renderLiveControl(status, config, { doctor: true });
    expect(text).toContain('LIVE TRADING CONFIG DOCTOR');
    expect(text).not.toContain('7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv');  // full key not echoed
  });

  it('renders status sections and a next action', () => {
    seedOpenPosition();
    const { status, config } = runLiveControl(opts());
    const text = renderLiveControl(status, config);
    expect(text).toContain('LIVE OPERATOR CONTROL CENTER');
    expect(text).toContain('POSITIONS & P/L');
    expect(text).toContain('NEXT ACTION');
  });

  it('kill switch surfaces in next action', () => {
    const { status } = runLiveControl(opts({ env: { [ENV.KILL_SWITCH]: '1' } }));
    expect(status.killSwitchOn).toBe(true);
    expect(status.nextAction).toMatch(/Kill switch/i);
  });
});
