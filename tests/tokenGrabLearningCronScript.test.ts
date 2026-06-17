import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const REPO_ROOT  = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'run-token-grab-learning-cron.sh');
const PKG_PATH    = path.join(REPO_ROOT, 'package.json');

const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const pkg    = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8')) as Record<string, unknown>;
const scripts = pkg['scripts'] as Record<string, string>;

// ── Script exists ─────────────────────────────────────────────────────────────

describe('script file', () => {
  it('exists at scripts/run-token-grab-learning-cron.sh', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('uses set -euo pipefail', () => {
    expect(script).toContain('set -euo pipefail');
  });
});

// ── Required commands ─────────────────────────────────────────────────────────

describe('required report/learning commands', () => {
  it('contains token:ripper-paper-learning-loop', () => {
    expect(script).toContain('token:ripper-paper-learning-loop');
  });

  it('contains token:ripper-learning-memory', () => {
    expect(script).toContain('token:ripper-learning-memory');
  });

  it('contains token:ripper-learning-summary', () => {
    expect(script).toContain('token:ripper-learning-summary');
  });

  it('contains token:ripper-shadow-filter-candidate-comparison', () => {
    expect(script).toContain('token:ripper-shadow-filter-candidate-comparison');
  });

  it('contains token:ripper-autopilot-status', () => {
    expect(script).toContain('token:ripper-autopilot-status');
  });
});

// ── Forbidden commands ────────────────────────────────────────────────────────

describe('forbidden commands must be absent', () => {
  it('does NOT contain token:auto-paper', () => {
    expect(script).not.toContain('token:auto-paper');
  });

  it('does NOT contain token:paper-buy', () => {
    expect(script).not.toContain('token:paper-buy');
  });

  it('does NOT contain wallet signing language', () => {
    expect(script).not.toMatch(/signTransaction|signWallet|walletSign|keypair\.sign/i);
  });

  it('does NOT contain swap execution language', () => {
    expect(script).not.toMatch(/executeSwap|swapTransaction|sendSwap/i);
  });

  it('does NOT contain real trading enablement', () => {
    expect(script).not.toMatch(/enableRealTrading|realTrading\s*=\s*true/);
  });
});

// ── Safety markers ────────────────────────────────────────────────────────────

describe('safety markers', () => {
  it('contains DO_NOT_ENABLE_REAL_TRADING', () => {
    expect(script).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('contains reportOnly=true', () => {
    expect(script).toContain('reportOnly=true');
  });

  it('contains realTradingLocked=true', () => {
    expect(script).toContain('realTradingLocked=true');
  });

  it('contains paperOnly=true', () => {
    expect(script).toContain('paperOnly=true');
  });

  it('contains tradingExecuted=0', () => {
    expect(script).toContain('tradingExecuted=0');
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────

describe('logging behavior', () => {
  it('writes to logs/token-grab-learning directory', () => {
    expect(script).toContain('logs/token-grab-learning');
  });

  it('creates a timestamped log file', () => {
    expect(script).toMatch(/run-.*\.log/);
  });

  it('uses tee to capture all output', () => {
    expect(script).toContain('tee');
  });
});

// ── Final status ──────────────────────────────────────────────────────────────

describe('final status reporting', () => {
  it('reports completed successfully', () => {
    expect(script).toContain('COMPLETED SUCCESSFULLY');
  });

  it('reports failed step on failure', () => {
    expect(script).toContain('FAILED AT STEP');
  });

  it('prints log path in footer', () => {
    expect(script).toContain('Log path');
  });
});

// ── Lock guard ────────────────────────────────────────────────────────────────

describe('lock guard — prevent overlapping runs', () => {
  it('contains a LOCK_DIR variable', () => {
    expect(script).toContain('LOCK_DIR=');
  });

  it('uses mkdir atomically for the lock', () => {
    expect(script).toMatch(/mkdir.*LOCK_DIR|mkdir.*lock/);
  });

  it('writes current PID into lock dir', () => {
    expect(script).toContain('$$ > "$LOCK_DIR/pid"');
  });

  it('registers a cleanup trap on EXIT INT TERM', () => {
    expect(script).toMatch(/trap\s+cleanup\s+EXIT\s+INT\s+TERM/);
  });

  it('removes lock dir in cleanup function', () => {
    expect(script).toContain('rm -rf "$LOCK_DIR"');
  });

  it('prints a SKIP message when lock is held', () => {
    expect(script).toContain('[SKIP]');
  });

  it('prints instructions to kill and reset stuck run', () => {
    expect(script).toContain('rm -rf');
    expect(script).toContain('LOCK_DIR');
  });
});

// ── Timeout guard ─────────────────────────────────────────────────────────────

describe('timeout guard — prevents stuck learning loop', () => {
  it('defines LEARN_LOOP_TIMEOUT_SECS', () => {
    expect(script).toContain('LEARN_LOOP_TIMEOUT_SECS=');
  });

  it('timeout is set to ~25 minutes (1500 seconds)', () => {
    expect(script).toContain('LEARN_LOOP_TIMEOUT_SECS=1500');
  });

  it('uses a TIMEOUT_FLAG file to communicate timeout across subshell', () => {
    expect(script).toContain('TIMEOUT_FLAG=');
    expect(script).toContain('touch "$TIMEOUT_FLAG"');
  });

  it('backgrounds the learning loop and waits on the PID', () => {
    expect(script).toContain('LEARN_PID=$!');
    expect(script).toMatch(/wait\s+"\$LEARN_PID"/);
  });

  it('kills the killer process after learning loop finishes', () => {
    expect(script).toContain('KILLER_PID=$!');
    expect(script).toMatch(/kill\s+.*KILLER_PID/);
  });

  it('sets TIMED_OUT=true when flag file is present', () => {
    expect(script).toContain('TIMED_OUT=true');
  });

  it('prints TIMED_OUT in final status when timeout fires', () => {
    expect(script).toContain('Status    : TIMED_OUT');
  });
});

// ── Bash syntax ───────────────────────────────────────────────────────────────

describe('bash syntax', () => {
  it('passes bash -n syntax check', () => {
    expect(() => execSync(`bash -n "${SCRIPT_PATH}"`)).not.toThrow();
  });
});

// ── Package.json registration ─────────────────────────────────────────────────

describe('package.json', () => {
  it('registers token:ripper-learning-cron', () => {
    expect(scripts['token:ripper-learning-cron']).toBeDefined();
  });

  it('token:ripper-learning-cron calls the cron script', () => {
    expect(scripts['token:ripper-learning-cron']).toContain('run-token-grab-learning-cron.sh');
  });
});
