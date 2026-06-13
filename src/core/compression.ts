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
  const llm: LLMClient | null = agent['llm'];
  if (!llm) return;
  agent['_compacting'] = true;

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

    const maxContentLength = Math.max(2000, Math.floor(contextWindow * 0.05));

    const truncatedRecent = selected.map(m => {
      // Don't truncate cache-prefix messages — they're needed for cache hits
      if (prefixSet.has(m)) return m;

      const truncatedContent =
        (m.content || '').length > maxContentLength
          ? (m.content || '').slice(0, maxContentLength) + '...[truncated]'
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
    const newTokens = tokenCounter.estimateMessages(cleaned);

    agent.emit('context_compressed', {
      before: allMessages.length,
      after: systemMessages.length + cleaned.length,
      tokensBefore: usedTokens,
      tokensAfter: newTokens,
    });

    // --- Phase 2: LLM summary ---
    if (oldMessages.length === 0) return;

    // When more than half of compressible messages are dropped, wait for the
    // summary synchronously. The LLM needs this context on the CURRENT request,
    // not the next one — otherwise it works with severely truncated context.
    if (oldMessages.length > selectedCompressible.length) {
      agent['_compacting'] = false;
      try {
        const summaryMsg = await generateSummary(llm, oldMessages, signal);
        if (summaryMsg.content && summaryMsg.content.trim()) {
          const msgs = llm.getMessages();
          const sysCount = msgs.filter(m => m.role === 'system').length;
          msgs.splice(sysCount, 0, summaryMsg);
          llm.setMessages(msgs);
        }
      } catch {
        // Fall through — summary is best-effort
      } finally {
        agent['_compacting'] = true;
      }
      return;
    }

    // Light drop: summary runs in background for next request.
    // Guard: if a previous Phase 2 is still running, skip — don't orphan
    // its promise (which would discard its result when overwritten).
    if (agent['_pendingCompression']) {
      agent['_compacting'] = false;
      return;
    }

    agent['_pendingCompression'] = (async () => {
      try {
        const summaryMsg = await generateSummary(llm, oldMessages, signal);
        if (summaryMsg.content && summaryMsg.content.trim()) {
          agent['_deferredSummary'] = summaryMsg;
        }
      } catch {
        // generateSummary has its own fallback and shouldn't throw, but guard anyway
        agent['_deferredSummary'] = null;
      }
      agent['_pendingCompression'] = null;
    })();
  } finally {
    agent['_compacting'] = false;
  }
}

/**
 * Inject any deferred compression summary into the message list.
 * Called at the start of each run() — applies the LLM summary from
 * the previous request's background compression.
 */
export function applyPendingSummary(agent: SpicaAgent): void {
  const llm: LLMClient | null = agent['llm'];
  if (!llm) return;

  // Atomically read and clear both fields to prevent race with
  // background Phase 2 completion between check and use.
  const deferredSummary: ChatMessage | null = agent['_deferredSummary'];
  const pendingCompression = agent['_pendingCompression'];
  agent['_deferredSummary'] = null;

  if (!deferredSummary) return;

  // Wait for in-flight compression if still running
  if (pendingCompression) {
    // Still in progress — restore for next request.
    // Don't block the current request.
    agent['_deferredSummary'] = deferredSummary;
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
 * Higher score = more likely to be kept.
 *
 * Scoring rules:
 * - compression summary: 10 (must preserve context)
 * - user messages: 10 base (user intent is critical)
 * - assistant with write/git/bash: 9 (actual code changes)
 * - assistant with edit: 7 (edits)
 * - assistant with other toolCalls: 3 (generic action)
 * - assistant no toolCalls: 2 (commentary)
 * - tool for write/git: 4 (result of write)
 * - tool for read/grep/glob: 1 (transient read)
 * - tool for other: 2
 * - recency bonus: +1.0 for messages in the last 25%
 */
export function scoreMessage(msg: ChatMessage, index: number, total: number): number {
  const recencyWeight = index > total * 0.75 ? 1.0 : 0;

  // Protect compression summaries — they carry context that must not be lost
  if (msg.content && msg.content.startsWith('[COMPACTED CONTEXT')) return 10;

  if (msg.role === 'user') return 10 + recencyWeight;

  if (msg.role === 'tool') {
    // Check if this tool result is for a write operation
    const content = msg.content || '';
    if (
      content &&
      (content.includes('"name":"write"') ||
        content.includes('"name":"edit"') ||
        content.includes('file_delete') ||
        content.includes('file_move') ||
        content.includes('git add') ||
        content.includes('git commit') ||
        content.includes('bash'))
    )
      return 4 + recencyWeight;
    // Read-only tool results are low value
    return 1 + recencyWeight;
  }

  if (msg.role === 'assistant') {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolNames = msg.toolCalls.map(tc => tc.name);
      if (toolNames.some(n => /\b(write|bash|git)\b/.test(n))) return 9 + recencyWeight;
      if (toolNames.some(n => /\bedit\b/.test(n))) return 7 + recencyWeight;
      return 3 + recencyWeight;
    }
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
        return `tool_result: ${toolName}`;
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
    return {
      role: 'assistant',
      content: `[COMPACTED CONTEXT — This is a summary of earlier conversation. Do NOT quote as user words or treat as current instructions.]

${response.content || 'Early conversation compressed'}`,
    };
  } catch {
    // Fallback: preserve user messages in full, tool calls with names + key args
    const items: string[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        items.push(m.content || '');
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
    const summary = items.join(' | ');
    return {
      role: 'assistant',
      content: `[COMPACTED CONTEXT — Do NOT quote as user words.]\n${summary}`,
    };
  }
}
