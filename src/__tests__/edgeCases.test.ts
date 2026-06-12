// Test edge cases for session, token counter, and diff
import { saveSession, loadSession } from '../utils/session';
import { cleanMessages } from '../utils/messageCleaner';
import { TokenCounter } from '../llm/TokenCounter';
import { computeDiff, formatDiff } from '../cli/ui/diff';
import fs from 'fs-extra';
import type { ChatMessage } from '../llm/providers/BaseProvider';

describe('Edge Cases', () => {
  describe('Message Cleaner Edge Cases', () => {
    it('should remove empty assistant messages (no content, no toolCalls)', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '' }, // Should be removed
        { role: 'assistant', content: '' }, // Should be removed
        { role: 'assistant', content: 'Response' },
      ];
      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(2);
      expect(cleaned[0].role).toBe('user');
      expect(cleaned[1].role).toBe('assistant');
      expect(cleaned[1].content).toBe('Response');
    });

    it('should keep assistant messages with toolCalls even if content is empty', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'bash', arguments: {} }] },
        { role: 'tool', content: 'result', toolCallId: 'tc1' },
      ];
      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(3);
    });

    it('should remove consecutive duplicate user messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Same question' },
        { role: 'user', content: 'Same question' }, // Duplicate, should be removed
        { role: 'user', content: 'Same question' }, // Duplicate, should be removed
        { role: 'user', content: 'Different question' },
      ];
      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(2);
      expect(cleaned[0].content).toBe('Same question');
      expect(cleaned[1].content).toBe('Different question');
    });

    it('should handle mixed invalid messages', () => {
      const messages: ChatMessage[] = [
        { role: 'assistant', content: '' }, // Empty, remove
        { role: 'user', content: 'Test' },
        { role: 'assistant', content: '' }, // Empty, remove (after this, two 'Test' become consecutive)
        { role: 'user', content: 'Test' }, // Now consecutive duplicate, remove
        { role: 'assistant', content: 'Response' },
        { role: 'assistant', content: '' }, // Empty, remove
        { role: 'user', content: 'Next' },
      ];
      const cleaned = cleanMessages(messages);
      // After first pass (remove empty assistants): user-Test, user-Test, assistant-Response, user-Next
      // After second pass (remove consecutive dupes): user-Test, assistant-Response, user-Next
      expect(cleaned.length).toBe(3);
      expect(cleaned.map(m => m.content)).toEqual(['Test', 'Response', 'Next']);
    });

    it('should handle all empty assistant messages', () => {
      const messages: ChatMessage[] = [
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '' },
      ];
      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(0);
    });
  });

  describe('Session Edge Cases', () => {
    const testWorkspace = '/tmp/test-edge-session';

    beforeEach(() => {
      if (fs.existsSync(testWorkspace)) {
        fs.removeSync(testWorkspace);
      }
      fs.ensureDirSync(testWorkspace);
    });

    it('should handle empty messages array', () => {
      saveSession(testWorkspace, []);
      const loaded = loadSession(testWorkspace);
      expect(loaded!.messages).toEqual([]);
    });

    it('should handle unicode and special characters', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '你好世界 🎉 \n\t\r\\特殊字符' },
        { role: 'assistant', content: '回复: <script>alert("xss")</script>' },
      ];
      saveSession(testWorkspace, messages);
      const loaded = loadSession(testWorkspace);
      expect(loaded!.messages[0].content).toContain('你好世界');
      expect(loaded!.messages[1].content).toContain('<script>');
    });
  });
});

describe('TokenCounter Edge Cases', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
    counter.setContextWindow(100000);
  });

  it('should handle empty text', () => {
    expect(counter.estimateTokens('')).toBe(0);
  });

  it('should handle very long single message', () => {
    const msg = { role: 'user' as const, content: 'A'.repeat(50000) };
    const tokens = counter.estimateMessage(msg);
    expect(tokens).toBeGreaterThan(10000);
  });

  it('should handle message with many tool calls', () => {
    const msg = {
      role: 'assistant' as const,
      content: '',
      toolCalls: Array(50)
        .fill(null)
        .map((_, i) => ({
          id: `tc-${i}`,
          name: 'read',
          arguments: { path: `file${i}` },
        })),
    };
    const tokens = counter.estimateMessage(msg);
    expect(tokens).toBeGreaterThan(500);
  });

  it('should handle messages array with mixed types', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'bash', arguments: {} }] },
      { role: 'tool', content: 'result', toolCallId: 'tc-1' },
      { role: 'assistant', content: 'Final response' },
    ];
    const total = counter.estimateMessages(messages);
    expect(total).toBeGreaterThan(30);
  });
});

describe('Diff Edge Cases', () => {
  it('should handle empty old content (new file)', () => {
    const diff = computeDiff('', 'line1\nline2\nline3');
    expect(diff.length).toBe(3);
    expect(diff[0].type).toBe('add');
  });

  it('should handle empty new content (delete all)', () => {
    const diff = computeDiff('line1\nline2', '');
    expect(diff.length).toBe(2);
    expect(diff[0].type).toBe('remove');
  });

  it('should handle both empty', () => {
    const diff = computeDiff('', '');
    expect(diff.length).toBe(0);
  });

  it('should handle identical content', () => {
    const diff = computeDiff('same\ncontent', 'same\ncontent');
    expect(diff.length).toBe(2);
    expect(diff.every(d => d.type === 'context')).toBe(true);
  });

  it('should handle single line changes', () => {
    const diff = computeDiff('old', 'new');
    // Diff shows both remove and add for changed line
    expect(diff.length).toBe(2);
    expect(diff[0].type).toBe('remove');
    expect(diff[1].type).toBe('add');
  });

  it('should format diff correctly', () => {
    const diff = computeDiff('a\nb\nc', 'a\nx\nc');
    const formatted = formatDiff(diff, 2);
    expect(formatted).toContain('a');
    expect(formatted).toContain('x');
    expect(formatted).toContain('c');
  });
});
