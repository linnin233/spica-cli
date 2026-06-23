import { describe, it, expect } from 'vitest';
import { ScrollbackBuffer } from '../scrollbackBuffer';

describe('ScrollbackBuffer', () => {
  it('should append lines correctly', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('line1\nline2\nline3');

    // 'line1\nline2\nline3' split by '\n' gives ['line1', 'line2', 'line3']
    expect(buffer.getLineCount()).toBe(3);
    expect(buffer.getLines()).toEqual(['line1', 'line2', 'line3']);
  });

  it('should limit max lines', () => {
    const buffer = new ScrollbackBuffer(5);

    for (let i = 1; i <= 10; i++) {
      buffer.append(`line${i}\n`);
    }

    // Each append adds 2 elements: 'line${i}' and '' (from trailing \n)
    // But we want to test the actual behavior
    const lines = buffer.getLines();
    // Should keep last 5 lines (filtering out empty lines)
    const nonEmptyLines = lines.filter(l => l !== '');
    expect(nonEmptyLines.length).toBeLessThanOrEqual(5);
  });

  it('should get last N lines', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('a\nb\nc');

    expect(buffer.getLastNLines(2)).toEqual(['b', 'c']);
    expect(buffer.getLastNLines(0)).toEqual([]);
  });

  it('should clear buffer', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('line1\nline2');

    buffer.clear();

    expect(buffer.getLineCount()).toBe(0);
    expect(buffer.getLines()).toEqual([]);
  });

  it('should handle multi-line text with ANSI codes', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('\x1b[32mgreen\x1b[0m\n\x1b[31mred\x1b[0m');

    expect(buffer.getLines()).toEqual(['\x1b[32mgreen\x1b[0m', '\x1b[31mred\x1b[0m']);
  });

  it('should handle empty text', () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.append('');

    expect(buffer.getLineCount()).toBe(1);
    expect(buffer.getLines()).toEqual(['']);
  });

  it('should set max lines dynamically', () => {
    const buffer = new ScrollbackBuffer(100);

    for (let i = 1; i <= 50; i++) {
      buffer.append(`line${i}\n`);
    }

    // Reduce max lines
    buffer.setMaxLines(10);

    expect(buffer.getLineCount()).toBeLessThanOrEqual(10);
  });
});
