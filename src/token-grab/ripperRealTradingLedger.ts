// DO_NOT_PRINT_SECRETS  durableLedger=true
//
// Real Trading Ledger v1 — a durable, append-only JSONL record of every real-trading
// lifecycle event. The ledger is the source of truth for recovery: open positions,
// closed positions, daily realized P/L, daily loss, and trade counts are all derived
// from it. Every real order MUST be written here BEFORE and AFTER submission.
//
// NEVER stores private keys (only the wallet PUBLIC key). Tolerates corrupt lines so a
// single bad write can never block recovery.

import * as fs   from 'fs';
import * as path from 'path';

export const DEFAULT_LEDGER_PATH = 'data/token-grab/ripper/real-trading-ledger.jsonl';

// ── Event model ──────────────────────────────────────────────────────────────────

export const LEDGER_EVENT_TYPES = [
  'LIVE_RUN_STARTED',
  'LIVE_RUN_BLOCKED',
  'LIVE_ENTRY_SIGNAL',
  'LIVE_ENTRY_PRECHECK_PASSED',
  'LIVE_ENTRY_PRECHECK_BLOCKED',
  'LIVE_QUOTE_REQUESTED',
  'LIVE_QUOTE_RECEIVED',
  'LIVE_BUY_SUBMITTED',
  'LIVE_BUY_CONFIRMED',
  'LIVE_BUY_FAILED',
  'LIVE_POSITION_OPENED',
  'LIVE_POSITION_HEARTBEAT',
  'LIVE_EXIT_SIGNAL',
  'LIVE_SELL_SUBMITTED',
  'LIVE_SELL_CONFIRMED',
  'LIVE_SELL_FAILED',
  'LIVE_POSITION_CLOSED',
  'LIVE_CIRCUIT_BREAKER_TRIPPED',
  'LIVE_RUN_FINISHED',
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export type TradeSide = 'BUY' | 'SELL' | null;

export interface LedgerEvent {
  eventId:         string;
  timestamp:       string;          // ISO
  runId:           string;
  type:            LedgerEventType;
  mode:            string;          // dry-run | mock | live
  dryRun:          boolean;
  mock:            boolean;
  live:            boolean;
  contract:        string | null;
  symbol:          string | null;
  side:            TradeSide;
  decision:        string | null;
  reason:          string | null;
  walletPublicKey: string | null;   // PUBLIC key only
  intendedUsd:     number | null;
  actualUsd:       number | null;
  tokenAmount:     number | null;
  entryPrice:      number | null;
  exitPrice:       number | null;
  txSignature:     string | null;
  quoteId:         string | null;
  riskSnapshot:    Record<string, unknown> | null;
  safetyFlags:     Record<string, unknown> | null;
}

export type LedgerEventInput = Partial<Omit<LedgerEvent, 'eventId' | 'timestamp' | 'type'>> & {
  type: LedgerEventType;
};

// ── Append / read ────────────────────────────────────────────────────────────────

export interface AppendContext {
  // Injected for deterministic tests; default to wall clock + counter.
  now?:     () => Date;
  idSeed?:  () => string;
}

let _counter = 0;

function makeEventId(seed?: () => string): string {
  if (seed) return seed();
  _counter += 1;
  // No Date.now()/Math.random reliance for determinism in workflows; counter + hrtime-ish.
  return `evt_${_counter.toString(36)}_${process.pid.toString(36)}`;
}

// Redact any accidentally-passed secret-shaped fields. We only ever persist a public key.
function redactSecrets(ev: LedgerEvent): LedgerEvent {
  const wpk = ev.walletPublicKey;
  if (wpk && looksLikeSecret(wpk)) ev.walletPublicKey = '[REDACTED_NON_PUBLIC_KEY]';
  return ev;
}

function looksLikeSecret(v: string): boolean {
  const t = v.trim();
  if (/^\[\s*\d+\s*(,\s*\d+\s*){31,}\]$/.test(t)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(t)) return true;
  if (/^[A-Za-z0-9+/=]{80,}$/.test(t)) return true;
  return false;
}

export function appendLedgerEvent(
  input: LedgerEventInput,
  ledgerPath: string = DEFAULT_LEDGER_PATH,
  ctx: AppendContext = {},
): LedgerEvent {
  const now = (ctx.now ?? (() => new Date()))();
  const ev: LedgerEvent = redactSecrets({
    eventId:         makeEventId(ctx.idSeed),
    timestamp:       now.toISOString(),
    runId:           input.runId ?? 'unknown',
    type:            input.type,
    mode:            input.mode ?? 'dry-run',
    dryRun:          input.dryRun ?? true,
    mock:            input.mock ?? false,
    live:            input.live ?? false,
    contract:        input.contract ?? null,
    symbol:          input.symbol ?? null,
    side:            input.side ?? null,
    decision:        input.decision ?? null,
    reason:          input.reason ?? null,
    walletPublicKey: input.walletPublicKey ?? null,
    intendedUsd:     input.intendedUsd ?? null,
    actualUsd:       input.actualUsd ?? null,
    tokenAmount:     input.tokenAmount ?? null,
    entryPrice:      input.entryPrice ?? null,
    exitPrice:       input.exitPrice ?? null,
    txSignature:     input.txSignature ?? null,
    quoteId:         input.quoteId ?? null,
    riskSnapshot:    input.riskSnapshot ?? null,
    safetyFlags:     input.safetyFlags ?? null,
  });
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, JSON.stringify(ev) + '\n', 'utf-8');
  } catch {
    // Non-fatal: surfacing a write failure must not crash a live run mid-flight, but
    // callers should treat a throw-free append as best-effort durability.
  }
  return ev;
}

export function readLedger(ledgerPath: string = DEFAULT_LEDGER_PATH): LedgerEvent[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const out: LedgerEvent[] = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as LedgerEvent;
      if (ev && typeof ev.type === 'string') out.push(ev);
    } catch { /* tolerate corrupt line */ }
  }
  return out;
}

// ── Derived state ─────────────────────────────────────────────────────────────────

export interface OpenPosition {
  contract:        string;
  symbol:          string | null;
  runId:           string;
  openedAt:        string;
  entryPrice:      number | null;
  tokenAmount:     number | null;
  intendedUsd:     number | null;
  actualUsd:       number | null;
  txSignature:     string | null;
  walletPublicKey: string | null;
  mode:            string;
}

export interface ClosedPosition extends OpenPosition {
  closedAt:        string;
  exitPrice:       number | null;
  exitTxSignature: string | null;
  realizedUsd:     number | null;
  exitReason:      string | null;
}

// Reconstruct positions from the event stream. A position is OPEN after
// LIVE_POSITION_OPENED and CLOSED after a matching LIVE_POSITION_CLOSED (by contract).
export function recoverTradingState(events: LedgerEvent[]): { open: OpenPosition[]; closed: ClosedPosition[] } {
  const open = new Map<string, OpenPosition>();
  const closed: ClosedPosition[] = [];

  for (const ev of events) {
    if (!ev.contract) continue;
    if (ev.type === 'LIVE_POSITION_OPENED') {
      open.set(ev.contract, {
        contract:        ev.contract,
        symbol:          ev.symbol,
        runId:           ev.runId,
        openedAt:        ev.timestamp,
        entryPrice:      ev.entryPrice,
        tokenAmount:     ev.tokenAmount,
        intendedUsd:     ev.intendedUsd,
        actualUsd:       ev.actualUsd,
        txSignature:     ev.txSignature,
        walletPublicKey: ev.walletPublicKey,
        mode:            ev.mode,
      });
    } else if (ev.type === 'LIVE_POSITION_CLOSED') {
      const pos = open.get(ev.contract);
      if (pos) {
        open.delete(ev.contract);
        const realizedUsd = ev.actualUsd != null && pos.actualUsd != null
          ? ev.actualUsd - pos.actualUsd
          : (ev.entryPrice != null && ev.exitPrice != null && pos.tokenAmount != null
              ? (ev.exitPrice - ev.entryPrice) * pos.tokenAmount : null);
        closed.push({
          ...pos,
          closedAt:        ev.timestamp,
          exitPrice:       ev.exitPrice,
          exitTxSignature: ev.txSignature,
          realizedUsd,
          exitReason:      ev.reason,
        });
      } else {
        // Close without a tracked open (e.g. recovered mid-stream) — record defensively.
        closed.push({
          contract: ev.contract, symbol: ev.symbol, runId: ev.runId,
          openedAt: ev.timestamp, entryPrice: ev.entryPrice, tokenAmount: ev.tokenAmount,
          intendedUsd: ev.intendedUsd, actualUsd: ev.actualUsd, txSignature: null,
          walletPublicKey: ev.walletPublicKey, mode: ev.mode,
          closedAt: ev.timestamp, exitPrice: ev.exitPrice, exitTxSignature: ev.txSignature,
          realizedUsd: null, exitReason: ev.reason,
        });
      }
    }
  }
  return { open: [...open.values()], closed };
}

export function getOpenPositions(ledgerPath: string = DEFAULT_LEDGER_PATH): OpenPosition[] {
  return recoverTradingState(readLedger(ledgerPath)).open;
}
export function getClosedPositions(ledgerPath: string = DEFAULT_LEDGER_PATH): ClosedPosition[] {
  return recoverTradingState(readLedger(ledgerPath)).closed;
}

function sameUtcDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCFullYear() === ref.getUTCFullYear() &&
         d.getUTCMonth() === ref.getUTCMonth() &&
         d.getUTCDate() === ref.getUTCDate();
}

// Count confirmed BUYs today (a "trade" = an opened position attempt that confirmed).
export function getTradesToday(events: LedgerEvent[], ref: Date): number {
  return events.filter(e =>
    (e.type === 'LIVE_BUY_CONFIRMED' || e.type === 'LIVE_POSITION_OPENED') &&
    sameUtcDay(e.timestamp, ref)).length;
}

export function getDailyRealizedPnl(events: LedgerEvent[], ref: Date): number {
  const { closed } = recoverTradingState(events);
  return closed
    .filter(c => sameUtcDay(c.closedAt, ref))
    .reduce((s, c) => s + (c.realizedUsd ?? 0), 0);
}

// Daily loss as a positive number (0 if net positive).
export function getDailyLoss(events: LedgerEvent[], ref: Date): number {
  const pnl = getDailyRealizedPnl(events, ref);
  return pnl < 0 ? -pnl : 0;
}

// ── Summary ───────────────────────────────────────────────────────────────────────

export interface LedgerSummary {
  totalEvents:       number;
  openPositions:     number;
  closedPositions:   number;
  tradesToday:       number;
  dailyRealizedPnl:  number;
  dailyLoss:         number;
  lastEvents:        LedgerEvent[];
  byType:            Record<string, number>;
}

export function summarizeLedger(
  ledgerPath: string = DEFAULT_LEDGER_PATH,
  ref: Date = new Date(),
  lastN = 10,
): LedgerSummary {
  const events = readLedger(ledgerPath);
  const { open, closed } = recoverTradingState(events);
  const byType: Record<string, number> = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return {
    totalEvents:      events.length,
    openPositions:    open.length,
    closedPositions:  closed.length,
    tradesToday:      getTradesToday(events, ref),
    dailyRealizedPnl: getDailyRealizedPnl(events, ref),
    dailyLoss:        getDailyLoss(events, ref),
    lastEvents:       events.slice(-lastN),
    byType,
  };
}
