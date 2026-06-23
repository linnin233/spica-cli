import type { ChatMessage } from '../llm/providers/BaseProvider';

export function cleanMessages(messages: ChatMessage[], debug = false): ChatMessage[] {
  const result: ChatMessage[] = [];
  const usedToolCallIds = new Set<string>();

  // First pass: remove invalid messages (empty content, no toolCalls)
  const validMessages = messages.filter((m, i) => {
    // Remove empty assistant messages (no content and no toolCalls)
    if (m.role === 'assistant') {
      const hasContent = m.content && m.content.trim().length > 0;
      const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
      if (!hasContent && !hasToolCalls) {
        if (debug) {
          console.error('[cleanMessages] Removing empty assistant message at index', i);
        }
        return false;
      }
    }

    return true;
  });

  // Second pass: remove consecutive duplicate user messages AND duplicate tool messages
  const dedupedMessages = validMessages.filter((m, i) => {
    // Deduplicate user messages
    if (m.role === 'user' && i > 0) {
      const prev = validMessages[i - 1];
      if (prev.role === 'user' && prev.content === m.content) {
        if (debug) {
          console.error('[cleanMessages] Removing duplicate user message at index', i);
        }
        return false;
      }
    }

    // Deduplicate tool messages (same toolCallId and same result)
    if (m.role === 'tool' && i > 0) {
      const prev = validMessages[i - 1];
      if (prev.role === 'tool' && prev.toolCallId === m.toolCallId && prev.content === m.content) {
        if (debug) {
          console.error(
            '[cleanMessages] Removing duplicate tool message at index',
            i,
            'toolCallId:',
            m.toolCallId
          );
        }
        return false;
      }
    }

    return true;
  });

  // Third pass: ensure assistant-tool message pairing is correct
  for (let i = 0; i < dedupedMessages.length; i++) {
    const m = dedupedMessages[i];

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const expectedIds = m.toolCalls.map(tc => tc.id);
      let j = i + 1;
      const foundIds: string[] = [];

      while (j < dedupedMessages.length && dedupedMessages[j].role === 'tool') {
        foundIds.push(dedupedMessages[j].toolCallId || '');
        j++;
      }

      const missingOrReused = expectedIds.filter(
        id => !foundIds.includes(id) || usedToolCallIds.has(id)
      );

      if (missingOrReused.length === 0) {
        result.push({ role: 'assistant', content: m.content || '', toolCalls: m.toolCalls });
        for (let k = i + 1; k < j; k++) {
          result.push(dedupedMessages[k]);
          usedToolCallIds.add(dedupedMessages[k].toolCallId || '');
        }
      } else {
        // DEBUG: 检测到缺失的tool messages
        if (debug) {
          console.error('[cleanMessages] Missing tool messages for assistant:', {
            expectedIds,
            foundIds,
            missingOrReused,
            assistantContent: m.content?.slice(0, 50),
          });
        }
        result.push({ role: 'assistant', content: m.content || '' });
      }
      i = j - 1;
    } else if (m.role === 'tool') {
      // Skip orphan tool messages (will be handled in assistant-tool pairing)
      continue;
    } else {
      result.push({ role: m.role, content: m.content || '' });
    }
  }

  return result;
}
