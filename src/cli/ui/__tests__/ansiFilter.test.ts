import { describe, it, expect } from 'vitest';
import { ansiStrip, ansiClean } from '../ansiFilter';

describe('ansiStrip', () => {
  it('returns empty string for empty input', () => {
    expect(ansiStrip('')).toBe('');
  });

  it('preserves plain text unchanged', () => {
    expect(ansiStrip('hello world')).toBe('hello world');
  });

  it('strips CSI SGR color codes', () => {
    expect(ansiStrip('\x1b[1mhello\x1b[0m')).toBe('hello');
  });

  it('strips cursor hide/show sequences', () => {
    expect(ansiStrip('\x1b[?25hhello\x1b[?25l')).toBe('hello');
  });

  it('strips DSR cursor position report', () => {
    expect(ansiStrip('\x1b[6nhello\x1b[1;1R')).toBe('hello');
  });

  it('strips OSC title sequences', () => {
    expect(ansiStrip('\x1b]0;title\x07hello')).toBe('hello');
  });

  it('strips bracketed paste markers', () => {
    expect(ansiStrip('\x1b[200~pasted content\x1b[201~')).toBe('pasted content');
  });

  it('strips C0 control characters except tab and newline', () => {
    expect(ansiStrip('\x00\x01\x02hello\x7fworld')).toBe('helloworld');
  });

  it('preserves tabs and newlines', () => {
    expect(ansiStrip('hello\tworld\nfoo')).toBe('hello\tworld\nfoo');
  });

  it('strips mixed ANSI and control characters', () => {
    const input = '\x1b[?25l\x1b]0;spica\x07\x1b[1mHello\x1b[0m\x00\x1b[K World';
    expect(ansiStrip(input)).toBe('Hello World');
  });

  it('preserves Chinese characters with ANSI mixed in', () => {
    expect(ansiStrip('\x1b[32m你好\x1b[0m世界')).toBe('你好世界');
  });

  it('strips C1 escape sequences', () => {
    expect(ansiStrip('\x1bP0;title\x1b\\hello')).toBe('hello');
  });
});

describe('ansiClean', () => {
  it('returns empty string for empty input', () => {
    expect(ansiClean('')).toBe('');
  });

  it('preserves plain text', () => {
    expect(ansiClean('hello world')).toBe('hello world');
  });

  it('collapses 3+ consecutive newlines to 2 by default', () => {
    expect(ansiClean('hello\n\n\n\nworld')).toBe('hello\n\nworld');
  });

  it('preserves single newlines', () => {
    expect(ansiClean('hello\nworld')).toBe('hello\nworld');
  });

  it('preserves double newlines', () => {
    expect(ansiClean('hello\n\nworld')).toBe('hello\n\nworld');
  });

  it('respects maxConsecutiveNewlines option', () => {
    expect(ansiClean('a\n\n\n\nb', { maxConsecutiveNewlines: 1 })).toBe('a\nb');
  });

  it('strips ANSI and collapses newlines', () => {
    const input = '\x1b[1mhello\x1b[0m\n\n\n\n\x1b[32mworld\x1b[0m';
    expect(ansiClean(input)).toBe('hello\n\nworld');
  });

  it('preserves tabs', () => {
    expect(ansiClean('\x1b[1mhello\tworld\x1b[0m')).toBe('hello\tworld');
  });
});
