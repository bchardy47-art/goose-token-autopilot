import { describe, it, expect } from 'vitest';
import { runFinalAcceptanceProduct, renderFinalAcceptanceProduct } from '../src/token-grab/ripperFinalAcceptanceProduct';

describe('Final Product Acceptance v1', () => {
  it('passes all critical checks → FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT = YES', async () => {
    const r = await runFinalAcceptanceProduct({ generatedAt: '2026-06-20T12:00:00Z', now: new Date('2026-06-20T12:00:00Z') });
    const failed = r.checks.filter(c => c.critical && !c.pass);
    expect(failed, JSON.stringify(failed)).toHaveLength(0);
    expect(r.FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT).toBe('YES');
  });

  it('reports targeting, propagation, and quote-stage readiness', async () => {
    const r = await runFinalAcceptanceProduct({ now: new Date('2026-06-20T12:00:00Z') });
    expect(r.BUBBLEMAPS_TARGETING_READY).toBe('YES');
    expect(r.BUBBLEMAPS_PROPAGATION_READY).toBe('YES');
    expect(r.LIVE_RUNNER_CAN_REACH_QUOTE_STAGE).toBe('YES');
  });

  it('confirms UNKNOWN still blocked and mock full loop works', async () => {
    const r = await runFinalAcceptanceProduct({ now: new Date('2026-06-20T12:00:00Z') });
    expect(r.UNKNOWN_STILL_BLOCKED).toBe('YES');
    expect(r.MOCK_FULL_LOOP_READY).toBe('YES');
  });

  it('keeps live execution capability and safety intact', async () => {
    const r = await runFinalAcceptanceProduct({ now: new Date('2026-06-20T12:00:00Z') });
    expect(r.LIVE_EXECUTION_CAPABILITY_READY).toBe('YES');
    expect(r.REAL_TRADING_DEFAULT).toBe('OFF');
    expect(r.REAL_TRADING_UNLOCK_REQUIRED).toBe('YES');
    expect(r.REAL_TRADING_NOT_EXECUTED).toBe('YES');
  });

  it('reports current-market truth (separate from capability) and a remaining blocker field', async () => {
    const r = await runFinalAcceptanceProduct({ now: new Date('2026-06-20T12:00:00Z') });
    expect(['YES', 'NO']).toContain(r.CURRENT_MARKET_HOLDER_KNOWN_CANDIDATE_EXISTS);
    expect(typeof r.REMAINING_BLOCKER).toBe('string');
  });

  it('renders the product acceptance report', async () => {
    const r = await runFinalAcceptanceProduct({ now: new Date('2026-06-20T12:00:00Z') });
    const text = renderFinalAcceptanceProduct(r);
    expect(text).toContain('FINAL PRODUCT ACCEPTANCE');
    expect(text).toContain('FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT');
    expect(text).toContain('LIVE_RUNNER_CAN_REACH_QUOTE_STAGE');
    expect(text).toContain('REMAINING_BLOCKER');
  });

  it('produces valid JSON', async () => {
    const r = await runFinalAcceptanceProduct({ now: new Date('2026-06-20T12:00:00Z') });
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed.checks.length).toBeGreaterThan(7);
  });
});
