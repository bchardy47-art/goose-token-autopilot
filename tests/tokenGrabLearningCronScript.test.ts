import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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

// ── Package.json registration ─────────────────────────────────────────────────

describe('package.json', () => {
  it('registers token:ripper-learning-cron', () => {
    expect(scripts['token:ripper-learning-cron']).toBeDefined();
  });

  it('token:ripper-learning-cron calls the cron script', () => {
    expect(scripts['token:ripper-learning-cron']).toContain('run-token-grab-learning-cron.sh');
  });
});
