import type { SpicaAgent } from '../agent';
import { LLMClient } from '../llm/LLMClient';
import type { ChatMessage } from '../llm/providers/BaseProvider';
import { getCompactPrompt } from '../prompts/system';
import { cleanMessages } from '../utils/messageCleaner';

/**
 * Clean messages before sending to LLM.
 * Thin wrapper used by agent.setMessages().
 */
export function cleanMessagesForLLM(messages: ChatMessage[]): ChatMessage[] {
  return cleanMessages(messages);
}

// ── Token estimation helper ──

function estimateTokens(llm: LLMClient, messages: ChatMessage[]): number {
  const tc = llm.getTokenCounter();
  tc.setContextWindow(llm.getProvider().getContextWindow());
  return tc.estimateMessages(messages);
}

function isUnderThreshold(llm: LLMClient, targetTokens: number): boolean {
  const msgs = llm.getMessages();
  const nonSystem = msgs.filter(m => m.role !== 'system');
  return estimateTokens(llm, nonSystem) < targetTokens;
}

/**
 * Restore cache prefix after setMessages() to cover system messages.
 *
 * setMessages() resets cachePrefixEnd to -1 (no cache). System messages are
 * always at the start, never change, and are the most valuable cache target.
 * Restoring to cover them ensures API-side prompt caching continues to hit.
 */
function restoreCachePrefix(llm: LLMClient, systemMessageCount: number): void {
  const provider = llm.getProvider();
  if (typeof provider.setCachePrefixEnd === 'function') {
    provider.setCachePrefixEnd(systemMessageCount - 1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Snip — zero-cost removal of empty/useless turns
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove low-value messages with zero API cost.
 *
 * Removes:
 * - Tool results where content is empty or trivial (<20 chars, no error)
 * - Assistant toolCalls where all corresponding tool_results were removed
 * - Duplicate consecutive user messages (same content)
 *
 * Returns the filtered messages (does not mutate the provider directly —
 * caller applies via setMessages if changes were made).
 */
export function snipMessages(messages: ChatMessage[], cachePrefixEnd: number = -1): { messages: ChatMessage[]; removed: number } {
  const ERROR_PATTERN = /error|Error|FAILED|denied|refused|exception|stack trace|fatal/i;

  // Pass 1: identify which tool results to remove.
  // NEVER remove messages within the cache prefix — that would invalidate
  // API-side prompt caching and waste tokens on the next request.
  const toolResultsToRemove = new Set<ChatMessage>();
  for (let i = 0; i < messages.length; i++) {
    if (i <= cachePrefixEnd) continue; // cache-protected
    const m = messages[i];
    if (m.role === 'tool') {
      const content = (m.content || '').trim();
      if (content.length < 20 && !ERROR_PATTERN.test(content.slice(0, 200))) {
        toolResultsToRemove.add(m);
      }
    }
  }

  // Pass 2: identify toolCallIds that have ALL results removed
  const removedToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && toolResultsToRemove.has(m) && m.toolCallId) {
      removedToolCallIds.add(m.toolCallId);
    }
  }

  // But keep toolCallIds where ANY result is NOT removed
  for (const m of messages) {
    if (m.role === 'tool' && !toolResultsToRemove.has(m) && m.toolCallId) {
      removedToolCallIds.delete(m.toolCallId);
    }
  }

  // Pass 3: build filtered list.
  // Cache prefix messages pass through untouched (no toolCall stripping either).
  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    // Remove empty tool results (only non-prefix)
    if (toolResultsToRemove.has(m)) continue;

    // Assistant with toolCalls: strip orphaned calls (only non-prefix)
    if (i > cachePrefixEnd && m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const survivingCalls = m.toolCalls.filter(tc => !removedToolCallIds.has(tc.id));
      if (survivingCalls.length === 0) {
        result.push({ ...m, toolCalls: undefined });
        continue;
      }
      if (survivingCalls.length < m.toolCalls.length) {
        result.push({ ...m, toolCalls: survivingCalls });
        continue;
      }
    }

    // Suppress duplicate consecutive user messages (only non-prefix)
    if (i > cachePrefixEnd && m.role === 'user' && result.length > 0) {
      let isDuplicate = false;
      for (let j = result.length - 1; j >= 0; j--) {
        if (result[j].role === 'user') {
          if (result[j].content === m.content) isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) continue;
    }

    result.push(m);
  }

  return { messages: result, removed: messages.length - result.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Microcompact — zero-cost tool result truncation
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_RESULT_TRUNCATE_LIMIT = 20000; // chars

/**
 * Truncate excessively long tool results.
 *
 * Cache-aware: messages before cachePrefixEnd are NOT truncated
 * (to preserve API-side prompt caching).
 *
 * Returns whether any messages were modified in place.
 */
export function microcompactMessages(messages: ChatMessage[], cachePrefixEnd: number): number {
  let truncated = 0;
  for (let i = 0; i < messages.length; i++) {
    // Cache-aware: skip messages in the prefix (they're cached by the API)
    if (i <= cachePrefixEnd) continue;

    const m = messages[i];
    if (m.role === 'tool' && (m.content || '').length > TOOL_RESULT_TRUNCATE_LIMIT) {
      m.content = (m.content || '').slice(0, TOOL_RESULT_TRUNCATE_LIMIT) + '...[truncated]';
      truncated++;
    }
  }
  return truncated;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3: Context Collapse — LLM summary of middle range
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collapse the "middle" of a conversation, preserving:
 * - Early setup: first user message + following assistant response
 * - Recent tail: last N messages
 *
 * Only the middle range is summarized — cheaper and less destructive
 * than full AutoCompact.
 */
export async function collapseContext(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<boolean> {
  const llm = agent.getLLM();
  if (!llm) return false;

  const allMessages = llm.getMessages();
  const systemMessages = allMessages.filter(m => m.role === 'system');
  const nonSystem = allMessages.filter(m => m.role !== 'system');

  if (nonSystem.length < 12) return false; // Not enough to split

  const contextWindow = llm.getProvider().getContextWindow();
  const tailSize = contextWindow < 32000 ? 4 : 8;

  // Early setup: preserve the LAST user message before the tail.
  // This is the user's current instruction — the most important piece of
  // context. The FIRST user message (old behavior) is often irrelevant to
  // the current task in multi-topic sessions.
  // Compute tailStart and apply tool-chain boundary check.
  // `slice(-tailSize)` could cut in the middle of a tool-call chain,
  // producing orphan tool results without their parent assistant message.
  const rawTailStart = nonSystem.length - tailSize;
  const tailStart = ensureToolChainBoundary(nonSystem, rawTailStart);
  const tail = nonSystem.slice(tailStart);
  const tailSet = new Set(tail);
  const lastUserBeforeTail = findLastUserBeforeTail(nonSystem, tail);

  const earlySetup: ChatMessage[] = [];
  if (lastUserBeforeTail) {
    earlySetup.push(lastUserBeforeTail);
    // Include the assistant response that follows this user message
    const userIdx = nonSystem.indexOf(lastUserBeforeTail);
    const nextAssistant = nonSystem.slice(userIdx + 1).find(m => m.role === 'assistant');
    if (nextAssistant && !tailSet.has(nextAssistant)) earlySetup.push(nextAssistant);
  }

  // Determine if there's enough middle to collapse
  const earlySet = new Set(earlySetup);
  const middle = nonSystem.filter(m => !earlySet.has(m) && !tailSet.has(m));

  if (middle.length < 4) return false; // Not enough middle messages to justify collapse

  // Generate summary of middle messages
  const summaryMsg = await generateSummary(llm, middle, signal);

  // Build new messages: [system] + [early setup] + [summary] + [tail]
  const newMessages = [...systemMessages, ...earlySetup, summaryMsg, ...tail];
  llm.setMessages(newMessages);
  agent.setLastSyncedProviderIndex(newMessages.length - 1);
  restoreCachePrefix(llm, systemMessages.length);

  // Check if collapse brought us under target
  const underThreshold = isUnderThreshold(llm, targetTokens);

  agent.emit('context_compressed', {
    before: allMessages.length,
    after: newMessages.length,
    phase: underThreshold ? 'collapse-success' : 'collapse-insufficient',
    middleCount: middle.length,
    earlyCount: earlySetup.length,
    tailCount: tail.length,
  });

  return underThreshold;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 4: AutoCompact — full head LLM summary (last resort)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full head summarization — summarize ALL non-tail messages.
 * Highest cost, guaranteed to bring context under threshold.
 */
export async function autoCompactContext(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<void> {
  const llm: LLMClient | null = agent.getLLM();
  if (!llm) return;

  const allMessages = llm.getMessages();
  const systemMessages = allMessages.filter(m => m.role === 'system');
  const nonSystem = allMessages.filter(m => m.role !== 'system');

  if (nonSystem.length === 0) {
    agent.emit('context_compressed', {
      before: allMessages.length,
      after: allMessages.length,
      tokensBefore: 0,
      tokensAfter: 0,
      phase: 'auto-noop-empty',
    });
    return;
  }

  const contextWindow = llm.getProvider().getContextWindow();
  const usedTokens = estimateTokens(llm, nonSystem);

  if (usedTokens < targetTokens) {
    agent.emit('context_compressed', {
      before: allMessages.length,
      after: allMessages.length,
      tokensBefore: usedTokens,
      tokensAfter: usedTokens,
      phase: 'auto-noop-under-target',
    });
    return;
  }

  const baseTailSize = contextWindow < 32000 ? 4 : contextWindow < 200000 ? 6 : 8;

  // Ensure the LAST user message is ALWAYS preserved verbatim in the tail.
  // Without this, the user's actual latest instruction gets summarized and
  // the model may follow a conflated summary instead of the real request.
  const lastUserIdx = findLastIndex(nonSystem, m => m.role === 'user');
  let tailStart: number;
  if (lastUserIdx >= 0 && lastUserIdx >= nonSystem.length - baseTailSize) {
    // Last user is already in the default tail — use baseTailSize
    tailStart = nonSystem.length - baseTailSize;
  } else if (lastUserIdx >= 0) {
    // Last user is further back — extend tail to include it
    tailStart = Math.min(lastUserIdx, nonSystem.length - 1);
  } else {
    tailStart = nonSystem.length - baseTailSize;
  }
  // Don't split tool-call chains — if tailStart would orphan a tool result
  // from its parent assistant tool_calls, extend backward to keep the chain intact.
  tailStart = ensureToolChainBoundary(nonSystem, tailStart);
  const tail = nonSystem.slice(tailStart);
  const head = nonSystem.slice(0, tailStart);

  if (head.length === 0) {
    agent.emit('context_compressed', {
      before: allMessages.length,
      after: allMessages.length,
      tokensBefore: usedTokens,
      tokensAfter: usedTokens,
      phase: 'auto-noop-all-tail',
    });
    return;
  }

  const summaryMsg = await generateSummary(llm, head, signal);
  const newMessages = [...systemMessages, summaryMsg, ...tail];
  llm.setMessages(newMessages);
  agent.setLastSyncedProviderIndex(newMessages.length - 1);
  restoreCachePrefix(llm, systemMessages.length);

  const newTokens = estimateTokens(llm, newMessages.filter(m => m.role !== 'system'));

  agent.emit('context_compressed', {
    before: allMessages.length,
    after: newMessages.length,
    tokensBefore: usedTokens,
    tokensAfter: newTokens,
    phase: 'auto-compact',
    headCount: head.length,
    tailCount: tail.length,
  });
}

// Backward-compatible alias
export { autoCompactContext as compressContext };

// ═══════════════════════════════════════════════════════════════════════════
// Unified waterfall: Layer 1 → 2 → 3 → 4
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manage context through a cost waterfall.
 *
 * Each layer is progressively more expensive but more powerful.
 * Returns early as soon as context is under the target threshold.
 *
 * Called before every LLM request and mid-loop (every 4 rounds).
 */
export async function manageContext(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<void> {
  const llm = agent.getLLM();
  if (!llm) return;

  // Prevent re-entry — only one compression at a time
  if (agent.isCompacting()) return;

  agent.setCompacting(true);
  const prevState = agent.stateMachine.current;
  agent.stateMachine.transition('compacting');

  let compressed = false;

  try {
    // ── Layer 1: Snip (zero cost) ──
    const allMessages = llm.getMessages();
    const cachePrefixEnd = llm.getProvider().getCachePrefixEnd?.() ?? -1;
    const { messages: snipped, removed } = snipMessages(allMessages, cachePrefixEnd);
    if (removed > 0) {
      compressed = true;
      llm.setMessages(snipped);
      agent.setLastSyncedProviderIndex(snipped.length - 1);
      restoreCachePrefix(llm, snipped.filter(m => m.role === 'system').length);
      agent.emit('context_compressed', {
        before: allMessages.length,
        after: snipped.length,
        phase: 'snip',
        removed,
      });
      if (isUnderThreshold(llm, targetTokens)) return;
    }

    // ── Layer 2: Microcompact (zero cost, cache-aware) ──
    const msgs = llm.getMessages();
    const truncated = microcompactMessages(msgs, cachePrefixEnd);
    if (truncated > 0) {
      compressed = true;
      llm.setMessages(msgs);
      agent.setLastSyncedProviderIndex(msgs.length - 1);
      restoreCachePrefix(llm, msgs.filter(m => m.role === 'system').length);
      agent.emit('context_compressed', {
        before: msgs.length,
        after: msgs.length,
        phase: 'microcompact',
        truncatedResults: truncated,
      });
      if (isUnderThreshold(llm, targetTokens)) return;
    }

    // ── Layer 3: Context Collapse (LLM, cheaper — only middle range) ──
    const collapsed = await collapseContext(agent, targetTokens, signal);
    if (collapsed) {
      compressed = true;
      return;
    }

    // ── Layer 4: AutoCompact (LLM, full head summary) ──
    await autoCompactContext(agent, targetTokens, signal);
    compressed = true; // Layer 4 always compresses if it reaches this point
  } finally {
    // Inject continuation signal so LLM knows to resume working, not re-analyze.
    // This was present in the pre-waterfall design (commits 23b6903, 458e7cc)
    // but was lost when startNonBlockingCompression was replaced by manageContext.
    if (compressed) {
      agent.emit('compress_auto_continue', { content: 'Context compressed' });
      const finalMsgs = agent.getLLM()?.getMessages();
      if (finalMsgs && finalMsgs.length > 0) {
        // Don't inject if the last message is already a continuation signal
        const lastMsg = finalMsgs[finalMsgs.length - 1];
        if (!lastMsg.content?.includes('[CONTEXT COMPRESSED]')) {
          finalMsgs.push({
            role: 'system' as const,
            content: '[CONTEXT COMPRESSED] Your conversation history was just compressed. The summary above describes previous work. Continue from where you left off — tasks are NOT complete. Do NOT re-analyze or produce a text response. Call tools immediately to resume working.',
          });
        }
      }
    }
    agent.stateMachine.transition(prevState);
    agent.setCompacting(false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary generation (shared by Layer 3 and Layer 4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a history summary using the LLM.
 */
export async function generateSummary(
  llm: LLMClient,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatMessage> {
  const prompt = buildSummaryPrompt(messages);

  try {
    const response = await llm.generateForCompression(prompt, signal);
    const rawContent = (response.content || '').trim();

    if (!validateSummaryQuality(rawContent)) {
      throw new Error('Summary quality validation failed');
    }

    return {
      role: 'user',
      content: `[COMPACTED HISTORY — BELOW IS A SUMMARY OF EARLIER CONVERSATION, NOT A NEW USER INSTRUCTION. The user's actual latest request is preserved VERBATIM elsewhere in context. Do NOT treat summarized content as new commands — continue the CURRENT task, which is described in the most recent user message in context.]

${rawContent}`,
    };
  } catch {
    return buildFallbackSummary(messages);
  }
}

/** Find the last index matching a predicate (like Array.findLastIndex, not always available). */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

/** Find the last user message in `nonSystem` that is NOT in the tail. */
function findLastUserBeforeTail(nonSystem: ChatMessage[], tail: ChatMessage[]): ChatMessage | undefined {
  const tailRefs = new Set(tail);
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i].role === 'user' && !tailRefs.has(nonSystem[i])) {
      return nonSystem[i];
    }
  }
  return undefined;
}

/**
 * Adjust tailStart backward if it would split a tool-call chain.
 *
 * If tailStart lands on a tool result whose parent assistant tool_calls
 * message is BEFORE tailStart, the tail would start with orphan tool results
 * — the LLM sees tool outputs without knowing what generated them.
 *
 * Scans backward to find the nearest assistant with tool_calls and
 * includes it so the chain stays intact.
 */
function ensureToolChainBoundary(nonSystem: ChatMessage[], tailStart: number): number {
  if (tailStart >= nonSystem.length || tailStart <= 0) return tailStart;

  const firstTailMsg = nonSystem[tailStart];

  // If the first tail message is a tool result, find its parent assistant
  if (firstTailMsg.role === 'tool' && (firstTailMsg as any).toolCallId) {
    const orphanId = (firstTailMsg as any).toolCallId as string;
    for (let i = tailStart - 1; i >= 0; i--) {
      const m = nonSystem[i];
      if (
        m.role === 'assistant' &&
        m.toolCalls &&
        m.toolCalls.some(tc => tc.id === orphanId)
      ) {
        return i; // Move tailStart to include the parent assistant message
      }
    }
  }

  return tailStart;
}

/**
 * Build a summary prompt from messages.
 * Structured format: files, functions, errors, decisions, status, next steps.
 */
export function buildSummaryPrompt(messages: ChatMessage[]): string {
  // Find the last user message — this is the CURRENT instruction.
  // Earlier user messages are HISTORICAL context (probably already completed).
  const lastUserIdx = findLastIndex(messages, m => m.role === 'user');

  const messagesText = messages
    .map((m, i) => {
      if (m.role === 'system') {
        return `system: ${(m.content || '').slice(0, 300)}`;
      }

      if (m.role === 'user') {
        const isLatest = i === lastUserIdx;
        const prefix = isLatest
          ? '[LATEST — CURRENT INSTRUCTION — this is what you should be working on RIGHT NOW]'
          : '[OLD — historical context, task may already be complete]';
        return `user ${prefix}: ${m.content || ''}`;
      }

      if (m.role === 'tool') {
        const toolName = (m as any).name || 'unknown';
        const tc = (m.content || '').slice(0, 500).replace(/\n/g, '\\n');
        const err = /error|Error|FAILED|denied|refused|stack trace|fatal/i.test(
          (m.content || '').slice(0, 200)
        );
        const errorTag = err ? ' ⚠️ERROR' : '';
        return `tool_result (${toolName})${errorTag}: ${tc}`;
      }

      // assistant
      if (m.toolCalls && m.toolCalls.length > 0) {
        const toolInfo = m.toolCalls
          .map(tc => {
            const args = tc.arguments || {};
            const keyArgs = ['path', 'command', 'action', 'pattern', 'query', 'url', 'question', 'prompt'];
            const keyArgsStr = Object.entries(args)
              .filter(([k]) => keyArgs.includes(k))
              .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join(', ');
            return keyArgsStr ? `${tc.name}(${keyArgsStr})` : tc.name;
          })
          .join('; ');
        const textContent = (m.content || '').slice(0, 300);
        return `assistant: [Tools: ${toolInfo}] ${textContent}`;
      }

      return `assistant: ${(m.content || '').slice(0, 300)}`;
    })
    .join('\n');

  return getCompactPrompt(messagesText);
}

/**
 * Build a rule-based fallback summary without calling the LLM.
 */
export function buildFallbackSummary(messages: ChatMessage[]): ChatMessage {
  const items: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push((m.content || '').slice(0, 200));
    } else if (m.toolCalls && m.toolCalls.length > 0) {
      const toolNames = m.toolCalls
        .map(tc => {
          const args = tc.arguments || {};
          const keyArgs = ['path', 'command', 'action', 'pattern', 'query', 'url', 'question', 'prompt'];
          const keyArgsStr = Object.entries(args)
            .filter(([k]) => keyArgs.includes(k))
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(', ');
          return keyArgsStr ? `${tc.name}(${keyArgsStr})` : tc.name;
        })
        .join(', ');
      items.push(`[${toolNames}]`);
    } else if (m.role === 'tool') {
      items.push(`[tool_result: ${(m as any).name || '?'}]`);
    }
  }
  const summary = items.join(' | ') || 'Early conversation compressed';
  return {
    role: 'user',
    content: `[COMPACTED HISTORY — rule-based summary of EARLIER conversation. This is NOT a new user instruction. Work is IN PROGRESS — continue the CURRENT task from the most recent user message in context.]
${summary}`,
  };
}

/**
 * Validate that an LLM-generated summary is actually useful.
 */
export function validateSummaryQuality(summary: string): boolean {
  if (!summary || summary.length < 50) return false;

  const boilerplate = [
    "I don't have",
    'no information',
    'Could you please',
    'unable to',
    'cannot provide',
    "I'm sorry",
    'Here is a summary',
    'Summary of',
    'I cannot',
  ];
  if (boilerplate.some(b => summary.includes(b))) return false;

  const contentSignals = [
    /\.ts\b/, /\.js\b/, /\.json\b/, /\.md\b/,
    /src\//, /lib\//, /test/,
    /\bfix(ed|es)?\b/, /\bcreat(e|ed|es)\b/,
    /\bmodif(y|ied)\b/, /\bdelet(e|ed|es)\b/,
    /\berror\b/i, /\bfail(ed)?\b/i,
    /\btest(s)?\b/i, /\bbuild\b/i,
    /\bfile\b/i, /\bfunction\b/i, /\bmodule\b/i,
  ];
  if (!contentSignals.some(s => s.test(summary))) return false;

  return true;
}
