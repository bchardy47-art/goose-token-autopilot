import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runScan } from '../src/scanner';
import { createDb } from '../src/db';
import { createTopProposal } from '../src/proposals/createProposal';
import { paperBuy, paperSell } from '../src/trading/paper';
import { buildReport, formatReport } from '../src/report';
import { executeBuy } from '../src/trading/real';
import { runAutopilot } from '../src/autopilot/runAutopilot';
import { seedScoredDb, makeTestConfig } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('functionality', () => {
  it('scanner can ingest fixture tokens', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'fixture' });
    cleanup.push(dir);
    const db = createDb(config);
    const result = await runScan(db, config);
    expect(result.scanned).toBeGreaterThan(0);
    expect(db.getTokenCount()).toBe(3);
    db.close();
  });

  it('scoring creates expected verdicts', async () => {
    const { dir, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const watch = db.findTokenByMint('WATCH111111111111111111111111111111111111111')!;
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    expect(db.getLatestScore(safe.id)!.verdict).toBe('AUTOPILOT_ELIGIBLE');
    expect(['WATCH', 'PAPER_BUY']).toContain(db.getLatestScore(watch.id)!.verdict);
    expect(db.getLatestScore(rug.id)!.verdict).toBe('AVOID');
    db.close();
  });

  it('proposal engine creates proposal for eligible token', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const proposal = createTopProposal(db, config);
    expect(proposal).not.toBeNull();
    expect(proposal!.amountUsd).toBeLessThanOrEqual(config.maxBuyUsd);
    db.close();
  });

  it('paper buy opens a position', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const proposal = createTopProposal(db, config)!;
    const result = paperBuy(db, config, { proposalId: proposal.id });
    const openPositions = db.listPositions('PAPER').filter((item) => item.status === 'OPEN');
    expect(result.positionId).toBeGreaterThan(0);
    expect(openPositions.length).toBe(1);
    db.close();
  });

  it('paper sell closes a position and calculates P/L', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const proposal = createTopProposal(db, config)!;
    const buyResult = paperBuy(db, config, { proposalId: proposal.id });
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.priceUsd = (snapshot.priceUsd ?? 0) * 1.5;
    db.insertSnapshot(safe.id, snapshot);
    const sellResult = paperSell(db, { positionId: buyResult.positionId });
    expect(sellResult.realizedPnlUsd).toBeGreaterThan(0);
    const closedPositions = db.listPositions('PAPER').filter((item) => item.status === 'CLOSED');
    expect(closedPositions.length).toBe(1);
    db.close();
  });

  it('report command works', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const output = formatReport(buildReport(db, config), config);
    expect(output).toContain('Goose Token Autopilot V1 Report');
    expect(output).toContain('Real trading remains locked by default in V1.');
    db.close();
  });

  it('safety events are logged', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    expect(() => paperBuy(db, config, { mint: 'RUG11111111111111111111111111111111111111111' })).toThrow();
    expect(Object.keys(db.getSafetyEventSummary()).length).toBeGreaterThan(0);
    db.close();
  });

  it('blocked real trade attempt is recorded', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const proposal = createTopProposal(db, config)!;
    const result = executeBuy(db, config, proposal.tokenId, proposal.id, proposal.amountUsd);
    expect(result.blocked).toBe(true);
    expect(db.getBlockedRealTradeAttempts()).toBeGreaterThan(0);
    db.close();
  });

  it('autopilot is safe by default and blocked', async () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const db = createDb(config);
    const result = await runAutopilot(db, config);
    expect(result.safeByDefault).toBe(true);
    expect(JSON.stringify(result)).toContain('blocked');
    db.close();
  });
});
