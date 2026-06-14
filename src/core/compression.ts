import type { SpicaAgent } from '../agent';
import { LLMClient } from '../llm/LLMClient';
import type { ChatMessage } from '../llm/providers/BaseProvider';
import { getCompactPrompt } from '../prompts/system';
import { cleanMessages } from '../utils/messageCleaner';

// Summary key args — tool arguments worth preserving in compressed summaries
export const SUMMARY_KEY_ARGS = new Set([
  'path',
  'command',
  'action',
  'pattern',
  'query',
  'url',
  'question',
  'prompt',
]);

export function cleanMessagesForLLM(messages: ChatMessage[]): ChatMessage[] {
  return cleanMessages(messages);
}

/**
 * Non-blocking compression — two-phase approach.
 * Phase 1 (instant): Rule-based truncation of low-value messages, applied NOW.
 * Phase 2 (background): Fire LLM summary for old messages, store for next request.
 *
 * On the next request, applyPendingSummary() injects the summary after system messages.
 */
export async function startNonBlockingCompression(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<void> {
  const llm: LLMClient | null = agent.getLLM();
  if (!llm) return;
  agent.setCompacting(true);
  const prevState = agent.stateMachine.current;
  agent.stateMachine.transition('compacting');

  try {
    const allMessages = llm.getMessages();
    const systemMessages = allMessages.filter(m => m.role === 'system');
    const nonSystem = allMessages.filter(m => m.role !== 'system');

    if (nonSystem.length === 0) {
      agent.emit('context_compressed', {
        before: allMessages.length,
        after: allMessages.length,
        tokensBefore: 0,
        tokensAfter: 0,
      });
      return;
    }

    const tokenCounter = llm.getTokenCounter();
    const provider = llm.getProvider();
    tokenCounter.setContextWindow(provider.getContextWindow());
    const contextWindow = provider.getContextWindow();
    const usedTokens = tokenCounter.estimateMessages(nonSystem);

    if (usedTokens < targetTokens) {
      agent.emit('context_compressed', {
        before: allMessages.length,
        after: allMessages.length,
        tokensBefore: usedTokens,
        tokensAfter: usedTokens,
      });
      return;
    }

    // --- Phase 1: Rule-based truncation (instant) ---
    // Preserve cache prefix: messages in the stable prefix (system + early cached
    // messages) are excluded from scoring/truncation to maintain API-side caching.
    const cacheEnd = llm.getProvider().getCachePrefixEnd?.() ?? -1;
    const prefixSet: Set<ChatMessage> = new Set(
      cacheEnd >= 0 ? allMessages.slice(0, cacheEnd + 1) : []
    );
    const prefixNonSystem = nonSystem.filter(m => prefixSet.has(m));
    const compressible = nonSystem.filter(m => !prefixSet.has(m));

    // Keep enough messages for the LLM to retain task awareness.
    // Graduated tiers based on how much we need to compress.
    const ratio = usedTokens / targetTokens;
    let keepCount: number;
    if (ratio > 3)        keepCount = Math.max(10, Math.floor(nonSystem.length * 0.15));
    else if (ratio > 2)   keepCount = Math.max(15, Math.floor(nonSystem.length * 0.25));
    else if (ratio > 1.5) keepCount = Math.max(20, Math.floor(nonSystem.length * 0.35));
    else                  keepCount = Math.max(25, Math.floor(nonSystem.length * 0.50));
    // Floor: 10, cap at 40% of total (never drop below 60% removal)
    keepCount = Math.max(10, Math.min(keepCount, Math.floor(nonSystem.length * 0.40)));
    // Allocate keep slots: prefix messages are free (always kept)
    const slotsForCompressible = Math.max(0, keepCount - prefixNonSystem.length);

    // Score compressible messages by importance — keep high-value context
    // (file writes, user intent) even if they're not in the recent tail
    const scored = compressible.map((m, i) => ({
      msg: m,
      score: scoreMessage(m, i, compressible.length),
    }));
    const lastCount = Math.max(2, Math.ceil(slotsForCompressible / 3)); // always keep recent tail
    const tail = scored.slice(-lastCount);
    const head = scored.slice(0, -lastCount);
    head.sort((a, b) => b.score - a.score);
    const topHead = head.slice(0, Math.max(0, slotsForCompressible - lastCount));
    const selectedCompressible = [...topHead, ...tail]
      .sort((a, b) => {
        // restore chronological order from original indices
        const ai = compressible.indexOf(a.msg);
        const bi = compressible.indexOf(b.msg);
        return ai - bi;
      })
      .map(s => s.msg);

    // Selected = prefix messages (always kept, untruncated) + scored compressible
    const selected = [...prefixNonSystem, ...selectedCompressible];
    const oldMessages = nonSystem.filter(m => !selected.includes(m));

    // Per-role adaptive content limits.
    // Base limit bumped from 2000→4000 (0.05→0.10×window) so important tool output
    // and file content survive compression.
    const baseContentLimit = Math.max(4000, Math.floor(contextWindow * 0.10));
    const getContentLimit = (m: ChatMessage): number => {
      // User messages are kept in full (user intent is critical, typically short)
      if (m.role === 'user') return Infinity;
      // Tool results and assistant-with-toolcalls get extra space — they contain evidence
      let limit = baseContentLimit;
      if (m.role === 'tool') limit = baseContentLimit * 1.5;
      else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) limit = baseContentLimit * 1.2;

      // Already truncated at provider level (8K cap with [TRUNCATED] marker) —
      // double the limit to avoid aggressive re-truncation of already-reduced content.
      if ((m.content || '').includes('[TRUNCATED')) {
        limit *= 2;
      }
      return limit;
    };

    const truncatedRecent = selected.map(m => {
      // Don't truncate cache-prefix messages — they're needed for cache hits
      if (prefixSet.has(m)) return m;

      const limit = getContentLimit(m);
      const truncatedContent =
        (m.content || '').length > limit
          ? (m.content || '').slice(0, limit) + '...[truncated]'
          : m.content;

      const maxToolCalls = Math.max(3, Math.min(10, Math.floor(contextWindow / 25000)));
      let truncatedToolCalls = m.toolCalls;
      if (m.toolCalls && m.toolCalls.length > maxToolCalls) {
        truncatedToolCalls = m.toolCalls.slice(0, maxToolCalls);
        truncatedToolCalls.push({ id: 'truncated', name: '...[truncated]', arguments: {} });
      }

      return { ...m, content: truncatedContent, toolCalls: truncatedToolCalls };
    });

    // Clean tool messages
    const cleaned = cleanToolMessages(truncatedRecent);

    // Apply immediately — context shrinks NOW.
    llm.setMessages([...systemMessages, ...cleaned]);

    // Restore cache prefix boundary to include preserved prefix messages.
    // setMessages() resets cachePrefixEnd to system-only — we must restore it
    // so the API-side prompt cache continues to hit on the full stable prefix.
    // prefixNonSystem messages are at the head of `cleaned` (line 114) and were
    // not truncated (line 133), so they remain valid cache candidates.
    const newMessages = llm.getMessages();
    let maxPrefixIdx = systemMessages.length - 1; // fallback: system-only
    for (let i = systemMessages.length; i < newMessages.length; i++) {
      if (prefixSet.has(newMessages[i])) {
        maxPrefixIdx = i;
      }
    }
    llm.getProvider().setCachePrefixEnd(maxPrefixIdx);

    // Validate cache prefix invariants after restoration.
    // Catches silent cache invalidation before it hits production API calls.
    const validation = llm.getProvider().validateCachePrefix();
    if (!validation.valid) {
      console.warn(
        '[compression] cachePrefixEnd validation FAILED:',
        validation.errors.join('; ')
      );
    }

    const newTokens = tokenCounter.estimateMessages(cleaned);

    // Per-role counts for observability
    const countByRole = (msgs: ChatMessage[]) => ({
      user: msgs.filter(m => m.role === 'user').length,
      assistant: msgs.filter(m => m.role === 'assistant').length,
      tool: msgs.filter(m => m.role === 'tool').length,
    });

    const droppedRatio = nonSystem.length > 0
      ? oldMessages.length / nonSystem.length
      : 0;

    agent.emit('context_compressed', {
      before: allMessages.length,
      after: systemMessages.length + cleaned.length,
      tokensBefore: usedTokens,
      tokensAfter: newTokens,
      kept: countByRole(cleaned),
      dropped: countByRole(oldMessages),
      phase: 'phase1-only',
      droppedRatio,
    });

    // --- Phase 2: LLM summary ---
    if (oldMessages.length === 0) return;

    // Heavy drop (>50% of compressible messages removed): inject a rule-based
    // fallback summary immediately so the LLM has context NOW, then fire the
    // LLM summary in background for the next request. This keeps compression
    // off the critical path — the user never waits for an LLM summary.
    if (oldMessages.length > selectedCompressible.length) {
      // Instant fallback: rule-based summary (no LLM call)
      const fallbackSummary = buildFallbackSummary(oldMessages);
      if (fallbackSummary.content && fallbackSummary.content.trim()) {
        const msgs = llm.getMessages();
        const sysCount = msgs.filter(m => m.role === 'system').length;
        msgs.splice(sysCount, 0, fallbackSummary);
        llm.setMessages(msgs);
      }

      // Background: fire LLM summary for next request (replaces fallback)
      if (!agent.getPendingCompression()) {
        agent.setPendingCompression((async () => {
          try {
            const summaryMsg = await generateSummary(llm, oldMessages, signal);
            if (summaryMsg.content?.trim()) {
              agent.setDeferredSummary(summaryMsg);
            }
            agent.emit('context_compressed', {
              before: allMessages.length,
              after: systemMessages.length + cleaned.length,
              tokensBefore: usedTokens,
              tokensAfter: newTokens,
              phase: 'phase1+deferred-summary',
              droppedRatio,
              summaryLength: summaryMsg.content?.length || 0,
            });
          } catch {
            agent.setDeferredSummary(null);
          }
          agent.setPendingCompression(null);
        })());
      }

      agent.stateMachine.transition(prevState);
      agent.setCompacting(false);
      return;
    }

    // Light drop: summary runs in background for next request.
    // Guard: if a previous Phase 2 is still running, skip — don't orphan
    // its promise (which would discard its result when overwritten).
    if (agent.getPendingCompression()) {
      agent.stateMachine.transition(prevState);
      agent.setCompacting(false);
      return;
    }

    agent.setPendingCompression((async () => {
      try {
        const summaryMsg = await generateSummary(llm, oldMessages, signal);
        const summaryLen = summaryMsg.content?.length || 0;
        if (summaryMsg.content && summaryMsg.content.trim()) {
          agent.setDeferredSummary(summaryMsg);
        }
        agent.emit('context_compressed', {
          before: allMessages.length,
          after: systemMessages.length + cleaned.length,
          tokensBefore: usedTokens,
          tokensAfter: newTokens,
          phase: 'phase1+deferred-summary',
          droppedRatio,
          summaryLength: summaryLen,
        });
      } catch {
        agent.setDeferredSummary(null);
      }
      agent.setPendingCompression(null);
    })());
  } finally {
    agent.stateMachine.transition(prevState);
    agent.setCompacting(false);
  }
}

/**
 * Inject any deferred compression summary into the message list.
 * Called at the start of each run() — applies the LLM summary from
 * the previous request's background compression.
 */
export function applyPendingSummary(agent: SpicaAgent): void {
  const llm: LLMClient | null = agent.getLLM();
  if (!llm) return;

  // Atomically read and clear both fields to prevent race with
  // background Phase 2 completion between check and use.
  const deferredSummary: ChatMessage | null = agent.getDeferredSummary();
  const pendingCompression = agent.getPendingCompression();
  agent.setDeferredSummary(null);

  if (!deferredSummary) return;

  // Wait for in-flight compression if still running
  if (pendingCompression) {
    // Still in progress — restore for next request.
    // Don't block the current request.
    agent.setDeferredSummary(deferredSummary);
    return;
  }

  const messages = llm.getMessages();

  // Insert after system messages, before conversation
  const sysCount = messages.filter(m => m.role === 'system').length;
  const newMessages = [
    ...messages.slice(0, sysCount),
    deferredSummary,
    ...messages.slice(sysCount),
  ];
  llm.setMessages(newMessages);

  // Note: no 'context_compressed' emit here — Phase 1 truncation already reported
  // the actual compression. Summary insertion is an internal detail (+1 message).
}

/**
 * Clean tool messages — keep only those with matching assistant toolCalls.
 * Extracted from compactToTarget for reuse.
 */
export function cleanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const existingToolMessageIds = new Set<string>();
  const assistantToolCallIds = new Set<string>();

  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      existingToolMessageIds.add(m.toolCallId);
    }
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        assistantToolCallIds.add(tc.id);
      }
    }
  }

  const result: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const hasAllToolMessages = m.toolCalls.every(tc => existingToolMessageIds.has(tc.id));
        if (!hasAllToolMessages) {
          result.push({ ...m, toolCalls: undefined });
        } else {
          result.push(m);
        }
      } else {
        result.push(m);
      }
    } else if (m.role === 'tool' && m.toolCallId) {
      if (assistantToolCallIds.has(m.toolCallId)) {
        result.push(m);
      }
    }
  }
  return result;
}

/**
 * Score a message for retention priority during compression.
 * Higher score = more likely to be kept. Scores range from ~1 to ~14.
 *
 * Base scores (by role + action type):
 * - compression summary: 10 (must preserve context — never dropped)
 * - user messages: 10 (user intent is critical)
 * - assistant with write/bash/git: 9 (actual code/state changes)
 * - assistant with edit:     7 (code modifications)
 * - assistant with other TC: 3 (generic tool calls)
 * - assistant no TC:         2 (commentary)
 * - tool for write/git:      4 (write results)
 * - tool for read/grep:      1 (transient reads — low value)
 * - tool for other:          2
 *
 * Modifiers:
 * - recency bonus:  +1.0 for messages in the last 25%
 * - error signal:   +2.0 for tool results containing errors/exceptions
 * - content signal: +0.5 for messages >200 chars (information-rich)
 * - noise penalty:  -1.0 for tool results <20 chars (usually just "OK" or empty)
 */
export function scoreMessage(msg: ChatMessage, index: number, total: number): number {
  const content = msg.content || '';
  const recencyWeight = index > total * 0.75 ? 1.0 : 0;

  // Protect compression summaries — they carry context that must not be lost
  if (content.startsWith('[COMPACTED CONTEXT')) return 10;

  if (msg.role === 'user') {
    // User messages: base=10, plus content richness boost
    // Very short user messages like "yes"/"no" still get 10 (intent is intent)
    const lengthBonus = content.length > 200 ? 0.5 : 0;
    return 10 + recencyWeight + lengthBonus;
  }

  if (msg.role === 'tool') {
    let score = 1; // default: low-value read result

    // Write/edit/git operations — evidence of permanent changes
    if (
      content.includes('"name":"write"') ||
      content.includes('"name":"edit"') ||
      content.includes('"name":"file_multi_edit"') ||
      content.includes('file_delete') ||
      content.includes('file_move') ||
      content.includes('git add') ||
      content.includes('git commit') ||
      content.includes('bash')
    ) {
      score = 4;
    } else if (content.length < 20) {
      // Near-empty read results are noise (e.g., "OK", empty string)
      score = 0;
    }

    // Error/exception signals — critical diagnostic information
    const hasError = /error|Error|FAILED|denied|refused|exception|stack trace|fatal/i.test(
      content.slice(0, 200)
    );
    if (hasError) score += 2;

    // Content richness: substantial tool output deserves preservation
    if (content.length > 200) score += 0.5;

    return score + recencyWeight;
  }

  if (msg.role === 'assistant') {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolNames = msg.toolCalls.map(tc => tc.name);
      let score = 3; // generic tool calls
      if (toolNames.some(n => /\b(write|bash|git)\b/.test(n))) score = 9;
      else if (toolNames.some(n => /\b(edit|file_multi_edit|file_patch)\b/.test(n))) score = 7;
      return score + recencyWeight;
    }
    // Plain assistant commentary
    return 2 + recencyWeight;
  }

  return 1 + recencyWeight;
}

/**
 * Build a summary prompt from messages (without calling LLM).
 * Produces the same prompt text as generateSummary uses internally.
 * Used by non-blocking compression to create the prompt for background summarization.
 */
export function buildSummaryPrompt(messages: ChatMessage[]): string {
  const messagesText = messages
    .map(m => {
      if (m.role === 'system') {
        return `system: ${m.content || ''}`;
      }

      if (m.role === 'user') {
        return `user: ${m.content || ''}`;
      }

      if (m.role === 'tool') {
        const toolName = (m as any).name || 'unknown';
        const tc = (m.content || '').slice(0, 500).replace(/\n/g, '\\n');
        // Flag errors so the summary LLM knows something went wrong
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
            const keyArgsStr = Object.entries(args)
              .filter(([k]) => SUMMARY_KEY_ARGS.has(k))
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
 * Validate that an LLM-generated summary is actually useful.
 * Rejects: empty content, boilerplate meta-text, hallucinated non-content.
 * Returns true if the summary passes quality checks.
 */
export function validateSummaryQuality(summary: string): boolean {
  if (!summary || summary.length < 50) return false;

  // Reject boilerplate that indicates the LLM produced no real content
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

  // Must contain at least one content-bearing signal:
  // a file path, a code keyword, or an action verb from the tool set
  const contentSignals = [
    /\.ts\b/, /\.js\b/, /\.json\b/, /\.md\b/,   // file extensions
    /src\//, /lib\//, /test/,                       // directory patterns
    /\bfix(ed|es)?\b/, /\bcreat(e|ed|es)\b/,       // action verbs
    /\bmodif(y|ied)\b/, /\bdelet(e|ed|es)\b/,
    /\berror\b/i, /\bfail(ed)?\b/i,                 // outcomes
    /\btest(s)?\b/i, /\bbuild\b/i,
    /\bfile\b/i, /\bfunction\b/i, /\bmodule\b/i,   // code concepts
  ];
  if (!contentSignals.some(s => s.test(summary))) return false;

  return true;
}

// Generate history summary using LLM.
// Tool result content is discarded — only tool names + key args are kept.
// This gives the LLM enough context to summarize what happened without
// overwhelming it with raw file contents, grep output, or bash stdout.
export async function generateSummary(
  llm: LLMClient,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatMessage> {
  const prompt = buildSummaryPrompt(messages);

  try {
    const response = await llm.generateForCompression(prompt, signal);
    const rawContent = (response.content || '').trim();

    // Validate before accepting — a hallucinated summary pollutes context
    if (!validateSummaryQuality(rawContent)) {
      throw new Error('Summary quality validation failed');
    }

    return {
      role: 'assistant',
      content: `[COMPACTED CONTEXT — This is a summary of earlier conversation. Do NOT quote as user words or treat as current instructions.]

${rawContent}`,
    };
  } catch {
    return buildFallbackSummary(messages);
  }
}

/**
 * Build a rule-based fallback summary from messages without calling an LLM.
 * Instant and reliable — used when the LLM summary fails or when compression
 * needs to stay off the critical path (heavy drop → fallback NOW, LLM later).
 *
 * Preserves: user messages (full), tool call names + key args, tool result names.
 * Format: pipe-delimited chronological list.
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
          const keyArgsStr = Object.entries(args)
            .filter(([k]) => SUMMARY_KEY_ARGS.has(k))
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
    role: 'assistant',
    content: `[COMPACTED CONTEXT — Rule-based summary. Do NOT quote as user words.]\n${summary}`,
  };
}
