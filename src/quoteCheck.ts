import type { AppDb } from './db';
import type { AppConfig, AvailabilityStatus, TokenCandidate } from './types';
import { AppLogger } from './logger';
import { redactString } from './redact';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';

function minutesSince(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / 60_000;
}

function buildPriorityTokenIds(db: AppDb, maxTokens: number): number[] {
  const watchIds = db.listWatchOnlyCandidates().map((candidate) => candidate.tokenId);
  const recentStateIds = db.listLatestTokenStates(100).map((state) => state.tokenId);
  return [...new Set([...watchIds, ...recentStateIds])].slice(0, maxTokens);
}

function getDecimals(snapshot: TokenCandidate): number | null {
  const decimals = Number((snapshot.raw as any)?.safetyEnrichment?.decimals);
  return Number.isFinite(decimals) && decimals >= 0 ? decimals : null;
}

function usdToRawAmount(snapshot: TokenCandidate, amountUsd: number): string | null {
  if ((snapshot.priceUsd ?? 0) <= 0) return null;
  const decimals = getDecimals(snapshot);
  if (decimals === null) return null;
  const tokenAmount = amountUsd / Math.max(snapshot.priceUsd ?? 0, Number.EPSILON);
  const raw = Math.round(tokenAmount * Math.pow(10, decimals));
  return raw > 0 ? String(raw) : null;
}

async function fetchJupiterQuote(snapshot: TokenCandidate, config: AppConfig, debug = false): Promise<{
  routeAvailable: boolean | null;
  expectedOutputAmount: string | null;
  estimatedSlippageBps: number | null;
  priceImpactPct: number | null;
  sellQuoteStatus: AvailabilityStatus;
  safetyStatus: string;
  errorSummary: string | null;
  debugInfo: Record<string, unknown>;
  raw: Record<string, unknown>;
}> {
  const decimals = getDecimals(snapshot);
  const sellAmountRaw = usdToRawAmount(snapshot, config.quoteCheckSellAmountUsd);
  if (!sellAmountRaw) {
    return {
      routeAvailable: null,
      expectedOutputAmount: null,
      estimatedSlippageBps: null,
      priceImpactPct: null,
      sellQuoteStatus: 'UNKNOWN',
      safetyStatus: 'UNKNOWN',
      errorSummary: 'unable to derive sell amount raw',
      debugInfo: {
        sellAmountUsd: config.quoteCheckSellAmountUsd,
        sellAmountRaw,
        decimalsSource: decimals === null ? 'missing' : 'safetyEnrichment.decimals',
        decimals,
        whyHighSlippageCounted: 'not-counted-no-slippage-known'
      },
      raw: { reason: 'missing_price_or_amount' }
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.quoteCheckTimeoutMs);
  try {
    const url = new URL(JUPITER_QUOTE_URL);
    url.searchParams.set('inputMint', snapshot.mint);
    url.searchParams.set('outputMint', SOL_MINT);
    url.searchParams.set('amount', sellAmountRaw);
    url.searchParams.set('slippageBps', String(config.quoteCheckSlippageBps));
    url.searchParams.set('onlyDirectRoutes', 'false');

    const sanitizedUrl = new URL(url.toString());
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'goose-token-autopilot/1.0' },
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        routeAvailable: null,
        expectedOutputAmount: null,
        estimatedSlippageBps: null,
        priceImpactPct: null,
        sellQuoteStatus: response.status >= 500 ? 'UNKNOWN' : 'NO',
        safetyStatus: response.status >= 500 ? 'UNKNOWN' : 'NO_ROUTE',
        errorSummary: `quote http ${response.status}`,
        debugInfo: {
          inputMint: snapshot.mint,
          outputMint: SOL_MINT,
          sellAmountUsd: config.quoteCheckSellAmountUsd,
          sellAmountRaw,
          decimalsSource: decimals === null ? 'missing' : 'safetyEnrichment.decimals',
          decimals,
          quoteUrl: redactString(sanitizedUrl.toString()),
          httpStatus: response.status,
          responseHasRoute: false,
          normalizedSellQuoteStatus: response.status >= 500 ? 'UNKNOWN' : 'NO',
          estimatedSlippageBps: null,
          whyHighSlippageCounted: 'not-counted-no-slippage-known'
        },
        raw: { status: response.status }
      };
    }

    const data = await response.json();
    const outAmount = typeof data?.outAmount === 'string' ? data.outAmount : null;
    const priceImpactPct = data?.priceImpactPct === undefined ? null : Number(data.priceImpactPct);
    const routePlan = Array.isArray(data?.routePlan) ? data.routePlan : [];
    const routeAvailable = routePlan.length > 0 && outAmount !== null;
    const estimatedSlippageBps = config.quoteCheckSlippageBps;
    const sellQuoteStatus: AvailabilityStatus = routeAvailable ? 'YES' : 'NO';
    const safetyStatus = routeAvailable && estimatedSlippageBps <= config.maxSlippageBps ? 'SELLABLE_LOW_SLIPPAGE' : routeAvailable ? 'SELLABLE_HIGH_SLIPPAGE' : 'NO_ROUTE';

    return {
      routeAvailable,
      expectedOutputAmount: outAmount,
      estimatedSlippageBps,
      priceImpactPct: Number.isFinite(priceImpactPct as number) ? Number((priceImpactPct as number).toFixed(6)) : null,
      sellQuoteStatus,
      safetyStatus,
      errorSummary: routeAvailable ? null : 'no sell route available',
      debugInfo: {
        inputMint: snapshot.mint,
        outputMint: SOL_MINT,
        sellAmountUsd: config.quoteCheckSellAmountUsd,
        sellAmountRaw,
        decimalsSource: decimals === null ? 'missing' : 'safetyEnrichment.decimals',
        decimals,
        quoteUrl: redactString(sanitizedUrl.toString()),
        httpStatus: response.status,
        responseHasRoute: routeAvailable,
        normalizedSellQuoteStatus: sellQuoteStatus,
        estimatedSlippageBps,
        whyHighSlippageCounted: estimatedSlippageBps !== null && estimatedSlippageBps > config.maxSlippageBps ? 'known-slippage-above-max' : 'not-counted-slippage-within-max'
      },
      raw: {
        outAmount,
        priceImpactPct,
        routePlanLength: routePlan.length
      }
    };
  } catch (error) {
    return {
      routeAvailable: null,
      expectedOutputAmount: null,
      estimatedSlippageBps: null,
      priceImpactPct: null,
      sellQuoteStatus: 'UNKNOWN',
      safetyStatus: 'UNKNOWN',
      errorSummary: error instanceof Error ? error.message : 'quote fetch failed',
      debugInfo: {
        inputMint: snapshot.mint,
        outputMint: SOL_MINT,
        sellAmountUsd: config.quoteCheckSellAmountUsd,
        sellAmountRaw,
        decimalsSource: decimals === null ? 'missing' : 'safetyEnrichment.decimals',
        decimals,
        quoteUrl: redactString(`${JUPITER_QUOTE_URL}?inputMint=${snapshot.mint}&outputMint=${SOL_MINT}&amount=${sellAmountRaw ?? 'null'}`),
        httpStatus: null,
        responseHasRoute: false,
        errorCodeOrMessage: error instanceof Error ? error.message : 'quote fetch failed',
        normalizedSellQuoteStatus: 'UNKNOWN',
        estimatedSlippageBps: null,
        whyHighSlippageCounted: 'not-counted-no-slippage-known'
      },
      raw: { error: error instanceof Error ? error.message : 'quote fetch failed' }
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runQuoteCheck(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<Record<string, unknown>> {
  const runLogId = db.createRunLog('token:quote-check');
  try {
    if (!config.enableQuoteCheck) {
      const summary = {
        checkedCount: 0,
        skippedCachedCount: 0,
        routeAvailableCount: 0,
        routeUnavailableCount: 0,
        unknownOrErrorCount: 0,
        highSlippageCount: 0,
        finalSafetyStatus: 'Real trading remains locked.'
      };
      db.finishRunLog(runLogId, 'SUCCESS', summary);
      return summary;
    }

    const tokenIds = buildPriorityTokenIds(db, config.quoteCheckMaxTokensPerRun);
    let checkedCount = 0;
    let skippedCachedCount = 0;
    let routeAvailableCount = 0;
    let routeUnavailableCount = 0;
    let unknownOrErrorCount = 0;
    let highSlippageCount = 0;

    for (const tokenId of tokenIds) {
      const token = db.getTokenRecord(tokenId);
      const snapshot = db.getLatestSnapshot(tokenId);
      if (!token || !snapshot || snapshot.chain !== 'solana') continue;

      const cached = db.getLatestQuoteSellabilityCheck(tokenId);
      if (cached && minutesSince(cached.checkedAt) < config.quoteCheckCacheMinutes) {
        skippedCachedCount += 1;
        continue;
      }

      const quote = await fetchJupiterQuote(snapshot, config, process.env.QUOTE_CHECK_DEBUG === 'true' && checkedCount === 0);
      const sellAmountRaw = usdToRawAmount(snapshot, config.quoteCheckSellAmountUsd);
      db.createQuoteSellabilityCheck(
        tokenId,
        snapshot.mint,
        new Date().toISOString(),
        'jupiter',
        snapshot.mint,
        SOL_MINT,
        config.quoteCheckSellAmountUsd,
        sellAmountRaw,
        quote.routeAvailable,
        quote.expectedOutputAmount,
        quote.estimatedSlippageBps,
        quote.priceImpactPct,
        quote.sellQuoteStatus,
        quote.safetyStatus,
        quote.errorSummary,
        { ...quote.raw, debugInfo: quote.debugInfo }
      );

      const sellQuoteAvailable: AvailabilityStatus = quote.routeAvailable === true
        ? (quote.estimatedSlippageBps !== null && quote.estimatedSlippageBps <= config.maxSlippageBps ? 'YES' : 'UNKNOWN')
        : quote.sellQuoteStatus;

      const updatedCandidate: TokenCandidate = {
        ...snapshot,
        sellQuoteAvailable,
        estimatedSlippageBps: quote.estimatedSlippageBps,
        dataUpdatedAt: new Date().toISOString(),
        raw: {
          ...snapshot.raw,
          quoteCheck: {
            provider: 'jupiter',
            routeAvailable: quote.routeAvailable,
            expectedOutputAmount: quote.expectedOutputAmount,
            priceImpactPct: quote.priceImpactPct,
            safetyStatus: quote.safetyStatus,
            errorSummary: quote.errorSummary
          }
        }
      };
      db.insertSnapshot(tokenId, updatedCandidate);

      checkedCount += 1;
      if (quote.routeAvailable === true) routeAvailableCount += 1;
      if (quote.routeAvailable === false) routeUnavailableCount += 1;
      if (quote.sellQuoteStatus === 'UNKNOWN' || quote.errorSummary) unknownOrErrorCount += 1;
      if (quote.estimatedSlippageBps !== null && quote.estimatedSlippageBps > config.maxSlippageBps) highSlippageCount += 1;

      if (process.env.QUOTE_CHECK_DEBUG === 'true' && checkedCount === 1) {
        logger.info('Quote check debug proof', {
          tokenId,
          mint: snapshot.mint,
          inputMint: snapshot.mint,
          outputMint: SOL_MINT,
          sellAmountUsd: config.quoteCheckSellAmountUsd,
          sellAmountRaw,
          decimalsSource: (quote.debugInfo as any)?.decimalsSource ?? 'unknown',
          quoteUrl: (quote.debugInfo as any)?.quoteUrl ?? '[UNAVAILABLE]',
          httpStatus: (quote.debugInfo as any)?.httpStatus ?? null,
          responseHasRoute: (quote.debugInfo as any)?.responseHasRoute ?? false,
          errorCodeOrMessage: (quote.debugInfo as any)?.errorCodeOrMessage ?? quote.errorSummary,
          normalizedSellQuoteStatus: quote.sellQuoteStatus,
          estimatedSlippageBps: quote.estimatedSlippageBps,
          whyHighSlippageCounted: (quote.debugInfo as any)?.whyHighSlippageCounted ?? 'not-counted-no-slippage-known'
        });
      }
    }

    const summary = {
      checkedCount,
      skippedCachedCount,
      routeAvailableCount,
      routeUnavailableCount,
      unknownOrErrorCount,
      highSlippageCount,
      finalSafetyStatus: 'Real trading remains locked.'
    };
    db.finishRunLog(runLogId, 'SUCCESS', summary);
    logger.info('Read-only quote sellability checks completed', summary);
    return summary;
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown quote check error' });
    throw error;
  }
}
