import { describe, it, expect } from 'vitest';
import { runFinalAcceptanceLive, renderFinalAcceptanceLive } from '../src/token-grab/ripperFinalAcceptanceLive';

describe('Final Live Acceptance v1', () => {
  it('passes all critical checks and reports FINISHED = YES', async () => {
    const r = await runFinalAcceptanceLive({ generatedAt: '2026-06-20T12:00:00Z' });
    const failedCritical = r.checks.filter(c => c.critical && !c.pass);
    expect(failedCritical, JSON.stringify(failedCritical)).toHaveLength(0);
    expect(r.FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY).toBe('YES');
  });

  it('confirms live defaults OFF and unlock required', async () => {
    const r = await runFinalAcceptanceLive();
    expect(r.LIVE_TRADING_DEFAULT).toBe('OFF');
    expect(r.LIVE_TRADING_UNLOCK_REQUIRED).toBe('YES');
  });

  it('confirms the real provider adapter is implemented (not a placeholder)', async () => {
    const r = await runFinalAcceptanceLive();
    expect(r.REAL_PROVIDER_ADAPTER_IMPLEMENTED).toBe('YES');
    expect(r.REAL_QUOTE_PATH_IMPLEMENTED).toBe('YES');
    expect(r.REAL_BUY_BUILD_PATH_IMPLEMENTED).toBe('YES');
    expect(r.REAL_SELL_BUILD_PATH_IMPLEMENTED).toBe('YES');
  });

  it('confirms dry-run + mock work and live refuses without unlock', async () => {
    const r = await runFinalAcceptanceLive();
    expect(r.DRY_RUN_EXECUTION_WORKS).toBe('YES');
    expect(r.MOCK_EXECUTION_WORKS).toBe('YES');
    expect(r.LIVE_RUNNER_REFUSES_WITHOUT_UNLOCK).toBe('YES');
  });

  it('confirms ledger recovery, circuit breakers, and paper mode intact', async () => {
    const r = await runFinalAcceptanceLive();
    expect(r.LEDGER_RECOVERY_READY).toBe('YES');
    expect(r.CIRCUIT_BREAKERS_ACTIVE).toBe('YES');
    expect(r.PAPER_MODE_STILL_WORKS).toBe('YES');
  });

  it('always asserts no real trade executed during build', async () => {
    const r = await runFinalAcceptanceLive();
    expect(r.REAL_TRADING_NOT_EXECUTED_DURING_BUILD).toBe('YES');
  });

  it('renders the acceptance report', async () => {
    const r = await runFinalAcceptanceLive();
    const text = renderFinalAcceptanceLive(r);
    expect(text).toContain('FINAL LIVE ACCEPTANCE');
    expect(text).toContain('FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY');
    expect(text).toContain('REAL_TRADING_NOT_EXECUTED_DURING_BUILD');
  });

  it('produces valid JSON', async () => {
    const r = await runFinalAcceptanceLive();
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed.checks.length).toBeGreaterThan(8);
  });
});
