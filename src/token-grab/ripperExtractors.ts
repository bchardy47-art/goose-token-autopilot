// Shared field extractors for ripper JSONL rows (cycle files, obs files, loose-extra, etc.)

export function extractRipperContract(row: Record<string, unknown>): string | null {
  const ns  = row['normalizedSignal'] as Record<string, unknown> | undefined;
  const raw = row['raw']             as Record<string, unknown> | undefined;
  const v =
    ns?.['contract'] ??
    raw?.['contract'] ??
    raw?.['address'] ??
    raw?.['tokenAddress'] ??
    row['contract'] ??
    null;
  return typeof v === 'string' ? v : null;
}

export function extractRipperPriceChangePct(row: Record<string, unknown>): number | null {
  const ns  = row['normalizedSignal'] as Record<string, unknown> | undefined;
  const raw = row['raw']             as Record<string, unknown> | undefined;
  if (typeof ns?.['priceChangePct'] === 'number')  return ns['priceChangePct']  as number;
  if (typeof raw?.['priceChangePct'] === 'number') return raw['priceChangePct'] as number;
  return null;
}
