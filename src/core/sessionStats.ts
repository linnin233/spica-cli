/**
 * Per-session cumulative API usage statistics.
 *
 * Two-phase tracking:
 * 1. countRequest() — called BEFORE each LLM call (always works, local)
 * 2. record(usage) — called AFTER LLM response with API-reported token counts
 *    (only works when provider supports stream_options.include_usage)
 *
 * Stats reset to zero when a new session starts (/new, /clear, /reset, /archive).
 *
 * Singleton pattern — imported once, shared everywhere.
 */

export interface UsageSnapshot {
  requestCount: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalCompletionTokens: number;
  /** true if API usage data has been received (provider supports it) */
  hasApiData: boolean;
  /** Cache hit rate as 0–1, or -1 if no data */
  cacheHitRate: number;
}

class SessionStats {
  requestCount = 0;
  totalPromptTokens = 0;
  totalCachedTokens = 0;
  totalCompletionTokens = 0;
  /** Whether we've received at least one batch of API usage data */
  hasApiData = false;

  /** Called before each LLM request — always works, no API dependency. */
  countRequest(): void {
    this.requestCount++;
  }

  /** Called when API returns usage data (may not be supported by all providers). */
  record(usage: {
    promptTokens?: number;
    cachedTokens?: number;
    completionTokens?: number;
  }): void {
    if (usage.promptTokens) this.totalPromptTokens += usage.promptTokens;
    if (usage.cachedTokens) this.totalCachedTokens += usage.cachedTokens;
    if (usage.completionTokens) this.totalCompletionTokens += usage.completionTokens;
    this.hasApiData = true;
  }

  /** Reset all counters — called on new session. */
  reset(): void {
    this.requestCount = 0;
    this.totalPromptTokens = 0;
    this.totalCachedTokens = 0;
    this.totalCompletionTokens = 0;
    this.hasApiData = false;
  }

  /** Snapshot for display. */
  snapshot(): UsageSnapshot {
    const rate =
      this.totalPromptTokens > 0
        ? this.totalCachedTokens / this.totalPromptTokens
        : -1;
    return {
      requestCount: this.requestCount,
      totalPromptTokens: this.totalPromptTokens,
      totalCachedTokens: this.totalCachedTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      hasApiData: this.hasApiData,
      cacheHitRate: rate,
    };
  }
}

/** Singleton instance. */
export const sessionStats = new SessionStats();
