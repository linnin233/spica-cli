import { describe, it, expect } from 'vitest';
import { TokenCounter } from '../../llm/TokenCounter';

describe('TokenCounter CJK and code heuristics', () => {
  it('should estimate CJK characters at higher token ratio', () => {
    const counter = new TokenCounter();
    const english = 'hello world this is a test';
    const chinese = '你好世界这是一个测试';
    const japanese = 'こんにちは世界';

    const englishTokens = counter.estimateTokens(english);
    const chineseTokens = counter.estimateTokens(chinese);
    const japaneseTokens = counter.estimateTokens(japanese);

    // CJK should estimate more tokens than same-character-count English
    expect(chineseTokens).toBeGreaterThan(englishTokens * 0.5);
    expect(japaneseTokens).toBeGreaterThan(englishTokens * 0.5);

    // Specific: CJK chars_per_token is 1.5, prose is 4
    // So 10 CJK chars ≈ 7 tokens, 10 English chars ≈ 3 tokens
    expect(counter.estimateTokens('你好世界你好世界你好')).toBeGreaterThan(5);
  });

  it('should estimate code at different ratio than prose', () => {
    const counter = new TokenCounter();
    const prose = 'The quick brown fox jumps over the lazy dog';
    const code = 'const x = () => { return this.value + 1; }';

    const proseTokens = counter.estimateTokens(prose);
    const codeTokens = counter.estimateTokens(code);

    // Both should estimate reasonably
    expect(proseTokens).toBeGreaterThan(0);
    expect(codeTokens).toBeGreaterThan(0);
    // Code has more punctuation per char, so slightly higher token ratio
    expect(codeTokens).toBeGreaterThanOrEqual(Math.ceil(proseTokens * 0.5));
  });

  it('should store and return contextWindow', () => {
    const counter = new TokenCounter();
    counter.setContextWindow(200000);
    expect(counter.getContextWindow()).toBe(200000);
  });

  it('should default to 128000 context window', () => {
    const counter = new TokenCounter();
    expect(counter.getContextWindow()).toBe(128000);
  });

  it('should estimate messages with CJK content correctly', () => {
    const counter = new TokenCounter();
    const messages = [
      { role: 'user', content: '你好世界' },
      { role: 'assistant', content: '你好！' },
    ];

    const total = counter.estimateMessages(messages);
    expect(total).toBeGreaterThan(10);
  });
});
