import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/run-token-grab-paper-learning-loop.sh');

function readScript(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf-8');
}

describe('run-token-grab-paper-learning-loop.sh — safety guards', () => {
  it('script file exists and is non-empty', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    expect(readScript().length).toBeGreaterThan(100);
  });

  it('does NOT contain token:auto-paper', () => {
    expect(readScript()).not.toContain('token:auto-paper');
  });

  it('does NOT contain token:paper-buy', () => {
    expect(readScript()).not.toContain('token:paper-buy');
  });

  it('does NOT contain wallet', () => {
    expect(readScript().toLowerCase()).not.toContain('wallet signing');
  });

  it('does NOT contain swap execution', () => {
    expect(readScript().toLowerCase()).not.toContain('swap execution');
  });
});

describe('run-token-grab-paper-learning-loop.sh — required commands', () => {
  it('contains token:dex-day-watch', () => {
    expect(readScript()).toContain('token:dex-day-watch');
  });

  it('contains token:ripper-paper-cycle', () => {
    expect(readScript()).toContain('token:ripper-paper-cycle');
  });

  it('contains token:ripper-paper-autopilot-cycle', () => {
    expect(readScript()).toContain('token:ripper-paper-autopilot-cycle');
  });

  it('contains token:ripper-shadow-reject-filter-enroll', () => {
    expect(readScript()).toContain('token:ripper-shadow-reject-filter-enroll');
  });

  it('contains token:ripper-paper-policy-test', () => {
    expect(readScript()).toContain('token:ripper-paper-policy-test');
  });

  it('contains token:ripper-shadow-enrolled-outcome-report', () => {
    expect(readScript()).toContain('token:ripper-shadow-enrolled-outcome-report');
  });

  it('contains token:ripper-autopilot-status', () => {
    expect(readScript()).toContain('token:ripper-autopilot-status');
  });
});

describe('run-token-grab-paper-learning-loop.sh — safety messaging', () => {
  it('contains DO_NOT_ENABLE_REAL_TRADING', () => {
    expect(readScript()).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('contains realTradingLocked=true', () => {
    expect(readScript()).toContain('realTradingLocked=true');
  });

  it('contains reportOnly=true', () => {
    expect(readScript()).toContain('reportOnly=true');
  });

  it('contains tradingExecuted=0', () => {
    expect(readScript()).toContain('tradingExecuted=0');
  });

  it('contains paperOnly=true', () => {
    expect(readScript()).toContain('paperOnly=true');
  });

  it('contains NO TRADES banner', () => {
    expect(readScript()).toContain('NO TRADES');
  });

  it('contains "Capture skipped: YES" early-exit check', () => {
    expect(readScript()).toContain('Capture skipped: YES');
  });

  it('contains 11-minute wait', () => {
    // 11 minutes = 660 seconds
    expect(readScript()).toContain('sleep 660');
  });
});

describe('package.json — learning loop script registered', () => {
  it('package.json contains token:ripper-paper-learning-loop entry', () => {
    const pkg = fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8');
    expect(pkg).toContain('token:ripper-paper-learning-loop');
    expect(pkg).toContain('run-token-grab-paper-learning-loop.sh');
  });
});

// ── Closeout timeout guard ────────────────────────────────────────────────────

describe('run-token-grab-paper-learning-loop.sh — closeout timeout guard', () => {
  it('defines CLOSEOUT_TIMEOUT_SECS', () => {
    expect(readScript()).toContain('CLOSEOUT_TIMEOUT_SECS=');
  });

  it('closeout timeout is 600 seconds (10 minutes)', () => {
    expect(readScript()).toContain('CLOSEOUT_TIMEOUT_SECS=600');
  });

  it('backgrounds the closeout subshell and stores its PID', () => {
    expect(readScript()).toContain('CLOSEOUT_PID=$!');
  });

  it('uses a flag file to detect closeout timeout', () => {
    expect(readScript()).toContain('CLOSEOUT_FLAG=');
    expect(readScript()).toContain('touch "$CLOSEOUT_FLAG"');
  });

  it('kills the closeout killer process after closeout finishes', () => {
    expect(readScript()).toContain('CLOSEOUT_KILLER=$!');
    expect(readScript()).toMatch(/kill\s+.*CLOSEOUT_KILLER/);
  });

  it('cleans up the flag file after timeout', () => {
    expect(readScript()).toContain('rm -f "$CLOSEOUT_FLAG"');
  });

  it('prints a TIMEOUT message when closeout is stopped', () => {
    expect(readScript()).toContain('[TIMEOUT]');
  });

  it('still contains sleep 660 for the 11-minute observation wait', () => {
    expect(readScript()).toContain('sleep 660');
  });
});

// ── Bash syntax ───────────────────────────────────────────────────────────────

describe('run-token-grab-paper-learning-loop.sh — bash syntax', () => {
  it('passes bash -n syntax check', () => {
    expect(() => execSync(`bash -n "${SCRIPT_PATH}"`)).not.toThrow();
  });
});
