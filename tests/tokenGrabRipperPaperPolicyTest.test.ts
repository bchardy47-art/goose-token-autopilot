import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runPaperPolicyTest,
  renderPaperPolicyTest,
  type PaperPolicyTestRow,
} from '../src/token-grab/ripperPaperPolicyTest';

const BASE_ISO = '2026-06-15T19:00:00.000Z';
const CA = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CB = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function cyclesDir(): string { return path.join(tmpDir, 'cycles'); }
function outPath():   string { return path.join(tmpDir, 'policy-test.jsonl'); }

function makeCyclesDir(): string {
  const d = cyclesDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeCycle(rows: object[], name = 'cycle-2026-06-15-190000.jsonl'): string {
  const d = makeCyclesDir();
  const p = path.join(d, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeApproved(opts: {
  contract?:    string;
  capturedAt?:  string;
  ageMinutes?:  number | null;
  liquidityUsd?: number | null;
  symbol?:      string;
} = {}) {
  return {
    capturedAt:      opts.capturedAt ?? BASE_ISO,
    buyGateDecision: 'BUY_APPROVED_PAPER',
    ripperScore:     100,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes:      opts.ageMinutes !== undefined ? opts.ageMinutes : 3,
    entryDecision:   'READY_TO_SNIPE_PAPER',
    normalizedSignal: {
      contract:    opts.contract ?? CA,
      symbol:      opts.symbol ?? 'TOK',
      id: 's', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [],
      liquidityUsd: opts.liquidityUsd !== undefined ? opts.liquidityUsd : 20_000,
    },
    raw: { clusterRisk: 'CLEAN' },
  };
}

function makeRejected(contract = CB) {
  return {
    capturedAt: BASE_ISO, buyGateDecision: 'BUY_REJECTED', ripperScore: 40,
    normalizedSignal: { contract, id: 'r', source: 'test', sourceKind: 'DEX_NEW_POOL', discoveredAt: BASE_ISO, warnings: [] },
    raw: { clusterRisk: 'WATCH' },
  };
}

function readRows(): PaperPolicyTestRow[] {
  const p = outPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as PaperPolicyTestRow);
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('safety fields', () => {
  it('result always has all safety flags', () => {
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.realTradingLocked).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.actualDecisionsChanged).toBe(0);
  });

  it('each row has all safety fields', () => {
    writeCycle([makeApproved()]);
    runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    const row = readRows()[0]!;
    expect(row.reportOnly).toBe(true);
    expect(row.readOnly).toBe(true);
    expect(row.tradingExecuted).toBe(0);
    expect(row.realTradingLocked).toBe(true);
    expect(row.paperOnly).toBe(true);
    expect(row.actualDecisionPreserved).toBe(true);
  });
});

// ── Empty / missing dir ───────────────────────────────────────────────────────

describe('empty cycles dir', () => {
  it('returns zero counts when dir does not exist', () => {
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.cycleFilesRead).toBe(0);
    expect(r.approvedAnalyzed).toBe(0);
    expect(r.rowsAppended).toBe(0);
    expect(r.latestCycleFile).toBeNull();
  });
});

// ── Feed file exclusion ───────────────────────────────────────────────────────

describe('excludes feed files', () => {
  it('ignores *-feed.json files', () => {
    const d = makeCyclesDir();
    fs.writeFileSync(path.join(d, 'cycle-2026-06-15-190000-feed.json'), JSON.stringify([makeApproved()]));
    writeCycle([makeApproved({ contract: CB })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.cycleFilesRead).toBe(1);
    expect(r.approvedAnalyzed).toBe(1);
  });
});

// ── Gate filtering ────────────────────────────────────────────────────────────

describe('gate filtering', () => {
  it('only includes BUY_APPROVED_PAPER candidates', () => {
    writeCycle([makeApproved({ contract: CA }), makeRejected(CB)]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.approvedAnalyzed).toBe(1);
    expect(r.rowsAppended).toBe(1);
    expect(readRows()[0]!.contract).toBe(CA);
  });
});

// ── liq_lt10k blocks ─────────────────────────────────────────────────────────

describe('liquidityUsd < 10000 blocks', () => {
  it('blocks when liquidityUsd is 5000', () => {
    writeCycle([makeApproved({ liquidityUsd: 5_000 })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByLiqOrAge).toBe(1);
    expect(r.blockedByLiquidity).toBe(1);
    expect(r.blockedByAge).toBe(0);
    const row = readRows()[0]!;
    expect(row.blockedByLiqOrAge).toBe(true);
    expect(row.policyTestWouldProceed).toBe(false);
    expect(row.blockReasons).toContain('liquidityUsd < $10k');
  });

  it('does not block when liquidityUsd is 20000', () => {
    writeCycle([makeApproved({ liquidityUsd: 20_000 })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByLiquidity).toBe(0);
  });

  it('does not block when liquidityUsd is null', () => {
    writeCycle([makeApproved({ liquidityUsd: null })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByLiquidity).toBe(0);
  });
});

// ── age_gte10m blocks ─────────────────────────────────────────────────────────

describe('ageMinutes >= 10 blocks', () => {
  it('blocks when ageMinutes is 12', () => {
    writeCycle([makeApproved({ ageMinutes: 12 })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByLiqOrAge).toBe(1);
    expect(r.blockedByAge).toBe(1);
    expect(r.blockedByLiquidity).toBe(0);
    const row = readRows()[0]!;
    expect(row.blockedByLiqOrAge).toBe(true);
    expect(row.policyTestWouldProceed).toBe(false);
    expect(row.blockReasons).toContain('ageMinutes >= 10');
  });

  it('does not block when ageMinutes is 3', () => {
    writeCycle([makeApproved({ ageMinutes: 3 })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByAge).toBe(0);
  });

  it('does not block when ageMinutes is null', () => {
    writeCycle([makeApproved({ ageMinutes: null })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByAge).toBe(0);
  });
});

// ── Neither condition proceeds ────────────────────────────────────────────────

describe('neither condition proceeds', () => {
  it('policyTestWouldProceed=true when neither liq nor age trigger', () => {
    writeCycle([makeApproved({ ageMinutes: 3, liquidityUsd: 20_000 })]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.policyTestWouldProceed).toBe(1);
    expect(r.blockedByLiqOrAge).toBe(0);
    const row = readRows()[0]!;
    expect(row.policyTestWouldProceed).toBe(true);
    expect(row.blockedByLiqOrAge).toBe(false);
    expect(row.blockReasons).toHaveLength(0);
  });
});

// ── normalPaperWouldProceed always true ───────────────────────────────────────

describe('normalPaperWouldProceed', () => {
  it('is always true regardless of filter outcome', () => {
    writeCycle([
      makeApproved({ contract: CA, ageMinutes: 15  }),  // blocked
      makeApproved({ contract: CB, ageMinutes: 3   }),  // not blocked
    ]);
    runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    for (const row of readRows()) {
      expect(row.normalPaperWouldProceed).toBe(true);
      expect(row.originalBuyGateDecision).toBe('BUY_APPROVED_PAPER');
    }
  });
});

// ── actualDecisionPreserved / tradingExecuted ─────────────────────────────────

describe('actualDecisionPreserved', () => {
  it('actualDecisionPreserved is true on all rows', () => {
    writeCycle([makeApproved({ ageMinutes: 15 }), makeApproved({ contract: CB })]);
    runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    for (const row of readRows()) expect(row.actualDecisionPreserved).toBe(true);
  });

  it('tradingExecuted is 0 on all rows', () => {
    writeCycle([makeApproved()]);
    runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    for (const row of readRows()) expect(row.tradingExecuted).toBe(0);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('deduplication', () => {
  it('skips duplicate rows on second run', () => {
    writeCycle([makeApproved()]);
    const r1 = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r1.rowsAppended).toBe(1);
    expect(r1.duplicatesSkipped).toBe(0);
    const r2 = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r2.rowsAppended).toBe(0);
    expect(r2.duplicatesSkipped).toBe(1);
    expect(readRows().length).toBe(1);
  });

  it('appends new cycle rows without re-appending existing', () => {
    writeCycle([makeApproved({ contract: CA })], 'cycle-2026-06-15-180000.jsonl');
    runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    const d = cyclesDir();
    fs.writeFileSync(path.join(d, 'cycle-2026-06-15-190000.jsonl'),
      JSON.stringify(makeApproved({ contract: CB })) + '\n');
    const r2 = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r2.rowsAppended).toBe(1);
    expect(r2.duplicatesSkipped).toBe(1);
    expect(readRows().length).toBe(2);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('includes PAPER POLICY TEST ONLY', () => {
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(renderPaperPolicyTest(r)).toContain('PAPER POLICY TEST ONLY');
  });

  it('includes NORMAL PAPER FLOW UNCHANGED', () => {
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(renderPaperPolicyTest(r)).toContain('NORMAL PAPER FLOW UNCHANGED');
  });

  it('includes DO_NOT_ENABLE_REAL_TRADING', () => {
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(renderPaperPolicyTest(r)).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('shows blocked counts', () => {
    writeCycle([
      makeApproved({ contract: CA, ageMinutes: 15 }),
      makeApproved({ contract: CB, liquidityUsd: 5_000 }),
    ]);
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    expect(r.blockedByLiqOrAge).toBe(2);
    expect(r.blockedByAge).toBe(1);
    expect(r.blockedByLiquidity).toBe(1);
    const out = renderPaperPolicyTest(r);
    expect(out).toContain('Blocked by liq_OR_age');
    expect(out).toContain('SAFETY CHECKS');
  });

  it('includes safety fields line', () => {
    const r = runPaperPolicyTest({ cyclesDir: cyclesDir(), outPath: outPath() });
    const out = renderPaperPolicyTest(r);
    expect(out).toContain('reportOnly=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
  });
});
