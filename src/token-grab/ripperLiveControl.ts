// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  operatorControlCenter=true
//
// Live Control v1 — the operator control center. Read-only status plus two safe
// mutations the operator explicitly requests: create/clear the daemon stop file.
// It NEVER trades, NEVER unlocks, and NEVER prints secrets.

import * as fs   from 'fs';
import * as path from 'path';

import { resolveLiveTradingConfig, renderLiveConfigDoctor, type LiveTradingConfig } from './ripperLiveTradingConfig';
import {
  summarizeLedger, recoverTradingState, readLedger,
  DEFAULT_LEDGER_PATH, type OpenPosition, type ClosedPosition, type LedgerEvent,
} from './ripperRealTradingLedger';
import { DEFAULT_STOP_FILE } from './ripperLiveDaemon';

export interface LiveControlOptions {
  env?:        Record<string, string | undefined>;
  ledgerPath?: string;
  stopFile?:   string;
  now?:        Date;
  // actions
  createStop?: boolean;
  clearStop?:  boolean;
}

export interface LiveControlStatus {
  liveUnlocked:     boolean;
  primaryState:     string;
  killSwitchOn:     boolean;
  executionMode:    string;
  openPositions:    OpenPosition[];
  closedPositions:  ClosedPosition[];
  realizedPnlToday: number;
  dailyLoss:        number;
  tradesToday:      number;
  lastEvents:       LedgerEvent[];
  stopFilePresent:  boolean;
  stopFilePath:     string;
  nextAction:       string;
  actionsTaken:     string[];
  // safety
  reportOnly:       boolean;     // true unless a stop action was requested
  noSecretsPrinted: true;
}

export function runLiveControl(opts: LiveControlOptions = {}): { status: LiveControlStatus; config: LiveTradingConfig } {
  const env = opts.env;
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const stopFile = opts.stopFile ?? DEFAULT_STOP_FILE;
  const now = opts.now ?? new Date();
  const config = resolveLiveTradingConfig({ env });

  const actionsTaken: string[] = [];
  // Safe, explicit operator mutations.
  if (opts.createStop) {
    try {
      fs.mkdirSync(path.dirname(stopFile), { recursive: true });
      fs.writeFileSync(stopFile, `STOP requested at ${now.toISOString()}\n`, 'utf-8');
      actionsTaken.push(`Created stop file: ${stopFile}`);
    } catch (err) { actionsTaken.push(`Failed to create stop file: ${errMsg(err)}`); }
  }
  if (opts.clearStop) {
    try {
      if (fs.existsSync(stopFile)) { fs.rmSync(stopFile); actionsTaken.push(`Cleared stop file: ${stopFile}`); }
      else actionsTaken.push('Stop file already absent.');
    } catch (err) { actionsTaken.push(`Failed to clear stop file: ${errMsg(err)}`); }
  }

  const summary = summarizeLedger(ledgerPath, now);
  const { open, closed } = recoverTradingState(readLedger(ledgerPath));
  const stopFilePresent = fs.existsSync(stopFile);

  const nextAction = computeNextAction(config, open.length, summary.dailyLoss, stopFilePresent);

  const status: LiveControlStatus = {
    liveUnlocked:     config.liveUnlocked,
    primaryState:     config.primaryState,
    killSwitchOn:     config.killSwitchOn,
    executionMode:    config.executionMode,
    openPositions:    open,
    closedPositions:  closed,
    realizedPnlToday: summary.dailyRealizedPnl,
    dailyLoss:        summary.dailyLoss,
    tradesToday:      summary.tradesToday,
    lastEvents:       summary.lastEvents,
    stopFilePresent,
    stopFilePath:     stopFile,
    nextAction,
    actionsTaken,
    reportOnly:       actionsTaken.length === 0,
    noSecretsPrinted: true,
  };
  return { status, config };
}

function computeNextAction(cfg: LiveTradingConfig, open: number, dailyLoss: number, stop: boolean): string {
  if (cfg.killSwitchOn) return 'Kill switch is ON. Live trading is blocked. Clear the kill switch env only when intended.';
  if (stop) return 'Daemon stop file is present — the daemon will not start new cycles. Clear it to resume (operator decision).';
  if (!cfg.liveUnlocked) return 'Live is locked. Run the config doctor; live stays OFF until fully unlocked (separate manual decision).';
  if (open > 0) return `${open} open position(s). Monitor exits via the daemon/runner. Real trading is unlocked — act deliberately.`;
  return 'Live unlocked, no open positions. Use the runner (--dry-run first) before any --live cycle.';
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

// ── Renderer ──────────────────────────────────────────────────────────────────

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

export function renderLiveControl(status: LiveControlStatus, config: LiveTradingConfig, opts: { doctor?: boolean } = {}): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — LIVE OPERATOR CONTROL CENTER');
  L.push('  [REAL TRADING DEFAULTS OFF — NO SECRETS PRINTED]');
  L.push(SEP, '');

  L.push(`  Live unlocked     : ${status.liveUnlocked ? 'YES' : 'NO'}  (${status.primaryState})`);
  L.push(`  Kill switch       : ${status.killSwitchOn ? 'ON (blocks live)' : 'off'}`);
  L.push(`  Execution mode    : ${status.executionMode}`);
  L.push(`  Daemon stop file  : ${status.stopFilePresent ? 'PRESENT (daemon will not run)' : 'absent'}  [${status.stopFilePath}]`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  POSITIONS & P/L');
  L.push(`  ${SEP2}`, '');
  L.push(`  Open positions    : ${status.openPositions.length}`);
  for (const p of status.openPositions) L.push(`    - ${(p.symbol ?? p.contract.slice(0, 10))}  usd=${p.actualUsd ?? '-'}  opened=${p.openedAt}`);
  L.push(`  Closed positions  : ${status.closedPositions.length}`);
  L.push(`  Realized P/L today: $${status.realizedPnlToday.toFixed(2)}`);
  L.push(`  Daily loss        : $${status.dailyLoss.toFixed(2)}`);
  L.push(`  Trades today      : ${status.tradesToday}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  LAST LEDGER EVENTS');
  L.push(`  ${SEP2}`, '');
  if (status.lastEvents.length === 0) L.push('  (none)');
  for (const e of status.lastEvents) L.push(`    ${e.timestamp}  ${e.type}  ${e.contract ?? ''}`);
  L.push('');

  if (status.actionsTaken.length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  ACTIONS TAKEN');
    L.push(`  ${SEP2}`, '');
    for (const a of status.actionsTaken) L.push(`    • ${a}`);
    L.push('');
  }

  L.push(`  ${SEP2}`);
  L.push('  NEXT ACTION');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${status.nextAction}`);
  L.push('');

  if (opts.doctor) {
    L.push(renderLiveConfigDoctor(config));
  } else {
    L.push('  SAFETY: real trading defaults OFF; unlock required; no secrets printed; UNKNOWN ≠ CLEAN.');
    L.push(SEP, '');
  }
  return L.join('\n');
}
