/**
 * TTL-based read-only tool result cache.
 *
 * Caches results for read-only tools (glob, grep, read, directory_list, file_exists)
 * to avoid redundant work across iterations. Invalidates automatically when any write
 * tool executes, and after a 30-second TTL.
 */

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'directory_list', 'file_exists']);

interface CacheEntry {
  result: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 30_000;

/** Build a deterministic cache key from tool name and arguments. */
function makeCacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

/** Check if a cache entry is still valid. */
function isValid(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < DEFAULT_TTL_MS;
}

/** Try to get a cached result. Returns the result string or null on miss. */
export function getCachedResult(toolName: string, args: Record<string, unknown>): string | null {
  if (!READ_TOOLS.has(toolName)) return null;
  const key = makeCacheKey(toolName, args);
  const entry = cache.get(key);
  if (entry && isValid(entry)) {
    return entry.result;
  }
  // Stale entry — clean up
  if (entry) cache.delete(key);
  return null;
}

/** Store a tool result in the cache. Only caches read-only tools. */
export function setCachedResult(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): void {
  if (!READ_TOOLS.has(toolName)) return;
  if (!result || result.length === 0) return; // don't cache empty results
  const key = makeCacheKey(toolName, args);
  cache.set(key, { result, timestamp: Date.now() });
}

/** Invalidate the entire cache — called after any write tool executes. */
export function invalidateCache(): void {
  cache.clear();
}

/** Invalidate cache entries older than TTL. Called periodically. */
export function evictStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > DEFAULT_TTL_MS * 2) {
      cache.delete(key);
    }
  }
}
