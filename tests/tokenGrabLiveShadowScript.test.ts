import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT   = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'run-live-shadow.sh');

const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');

// ── Script exists / valid bash ───────────────────────────────────────────────

describe('run-live-shadow.sh', () => {
  it('exists', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('uses set -euo pipefail', () => {
    expect(script).toContain('set -euo pipefail');
  });

  it('passes bash -n syntax check', () => {
    expect(() => execSync(`bash -n "${SCRIPT_PATH}"`)).not.toThrow();
  });
});

// ── Stale-source recovery: refresh BEFORE ripper-paper-cycle BEFORE live-shadow ───────────

describe('stale-source recovery ordering', () => {
  it('calls the one-shot dex feed refresh', () => {
    expect(script).toContain('token:dex-feed-refresh');
  });

  it('calls ripper-paper-cycle and live-shadow', () => {
    expect(script).toContain('token:ripper-paper-cycle');
    expect(script).toContain('token:live-shadow');
  });

  it('runs dex-feed-refresh BEFORE ripper-paper-cycle', () => {
    expect(script.indexOf('token:dex-feed-refresh')).toBeLessThan(
      script.indexOf('token:ripper-paper-cycle'),
    );
  });

  it('runs ripper-paper-cycle BEFORE the final live-shadow run', () => {
    expect(script.indexOf('token:ripper-paper-cycle')).toBeLessThan(
      script.lastIndexOf('token:live-shadow'),
    );
  });

  it('only refreshes when the source is stale (guards on a freshness check)', () => {
    expect(script).toMatch(/-mmin/);
    expect(script).toContain('STALE source');
  });
});

// ── Required log markers ─────────────────────────────────────────────────────

describe('log markers', () => {
  for (const marker of [
    'DEX_REFRESH_START',
    'DEX_REFRESH_END',
    'RIPPER_CYCLE_START',
    'RIPPER_CYCLE_END',
    'LIVE_SHADOW_START',
    'LIVE_SHADOW_END',
    'STALE_SOURCE_RECOVERY_OK',
    'STALE_SOURCE_RECOVERY_FAILED',
  ]) {
    it(`logs ${marker}`, () => {
      expect(script).toContain(marker);
    });
  }
});

// ── Lockfile prevents overlapping cron runs ──────────────────────────────────

describe('lockfile', () => {
  it('defines a lock dir', () => {
    expect(script).toContain('LOCKDIR=');
  });

  it('acquires the lock atomically with mkdir', () => {
    expect(script).toMatch(/mkdir "\$LOCKDIR"/);
  });

  it('skips (exits 0) when the lock is already held', () => {
    expect(script).toContain('already running');
    expect(script).toMatch(/exit 0/);
  });

  it('releases the lock on exit via trap', () => {
    expect(script).toMatch(/trap .*rmdir "\$LOCKDIR"/);
  });
});

// ── No unsafe trading code ───────────────────────────────────────────────────

describe('no unsafe trading code', () => {
  it('does NOT call token:auto-paper', () => {
    expect(script).not.toContain('token:auto-paper');
  });

  it('does NOT call token:paper-buy', () => {
    expect(script).not.toContain('token:paper-buy');
  });

  it('has no wallet/signing/swap/private-key language', () => {
    expect(script).not.toMatch(/signTransaction|keypair\.sign|executeSwap|sendSwap|privateKey/i);
  });

  it('does not enable real trading', () => {
    expect(script).not.toMatch(/enableRealTrading|REAL_TRADING=true|realTrading\s*=\s*true/);
  });
});

// ── Real-trading stays locked ────────────────────────────────────────────────

describe('safety banner', () => {
  it('keeps READY_FOR_REAL_TRADING=false', () => {
    expect(script).toContain('READY_FOR_REAL_TRADING=false');
    expect(script).not.toContain('READY_FOR_REAL_TRADING=true');
  });

  it('declares paper-only / tradingExecuted=0', () => {
    expect(script).toContain('paperOnly=true');
    expect(script).toContain('tradingExecuted=0');
  });
});
