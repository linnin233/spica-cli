// 全角字符宽度计算测试
import { isFullWidth, getStringWidth, getCharWidths } from '../stringWidth';

describe('FullWidth Character Detection', () => {
  describe('isFullWidth', () => {
    it('should detect CJK characters as fullwidth', () => {
      expect(isFullWidth('中')).toBe(true);
      expect(isFullWidth('文')).toBe(true);
      expect(isFullWidth('字')).toBe(true);
      expect(isFullWidth('你')).toBe(true);
      expect(isFullWidth('好')).toBe(true);
    });

    it('should detect fullwidth ASCII variants as fullwidth', () => {
      // U+FF01 - U+FF5E 范围
      expect(isFullWidth('！')).toBe(true); // U+FF01
      expect(isFullWidth('？')).toBe(true); // U+FF1F
      expect(isFullWidth('，')).toBe(true); // U+FF0C
      expect(isFullWidth('。')).toBe(true); // U+3002 (CJK Symbols)
      expect(isFullWidth('；')).toBe(true); // U+FF1B
      expect(isFullWidth('：')).toBe(true); // U+FF1A
      expect(isFullWidth('（')).toBe(true); // U+FF08
      expect(isFullWidth('）')).toBe(true); // U+FF09
    });

    it('should detect CJK symbols as fullwidth', () => {
      expect(isFullWidth('　')).toBe(true); // U+3000 全角空格
      expect(isFullWidth('。')).toBe(true); // U+3002
      expect(isFullWidth('、')).toBe(true); // U+3001
    });

    it('should not detect ASCII as fullwidth', () => {
      expect(isFullWidth('a')).toBe(false);
      expect(isFullWidth('Z')).toBe(false);
      expect(isFullWidth('!')).toBe(false); // 半角感叹号
      expect(isFullWidth('?')).toBe(false); // 半角问号
      expect(isFullWidth(',')).toBe(false); // 半角逗号
    });

    it('should not detect halfwidth katakana as fullwidth', () => {
      // 半角片假名 U+FF65 - U+FF9F 不应该被检测为全角
      expect(isFullWidth('ｱ')).toBe(false); // U+FF71 半角ア
      expect(isFullWidth('ｶ')).toBe(false); // U+FF76 半角カ
    });
  });

  describe('getStringWidth', () => {
    it('should calculate correct width for pure CJK', () => {
      expect(getStringWidth('你好')).toBe(4);
      expect(getStringWidth('世界')).toBe(4);
      expect(getStringWidth('你好世界')).toBe(8);
    });

    it('should calculate correct width for pure ASCII', () => {
      expect(getStringWidth('hello')).toBe(5);
      expect(getStringWidth('Hello')).toBe(5);
      expect(getStringWidth('test')).toBe(4);
    });

    it('should calculate correct width for mixed content', () => {
      expect(getStringWidth('Hello世界')).toBe(9); // 5 + 4
      expect(getStringWidth('测试Test')).toBe(8); // 4 + 4
    });

    it('should calculate correct width for fullwidth punctuation', () => {
      expect(getStringWidth('！？')).toBe(4); // 2 + 2
      expect(getStringWidth('，。')).toBe(4); // 2 + 2
      expect(getStringWidth('；：')).toBe(4); // 2 + 2
    });

    it('should calculate correct width for complex mixed', () => {
      expect(getStringWidth('测试Test！')).toBe(10); // 4 + 4 + 2
      expect(getStringWidth('Hello世界！')).toBe(11); // 5 + 4 + 2
      expect(getStringWidth('问：答。')).toBe(8); // 2 + 2 + 2 + 2
    });

    it('should handle newline correctly', () => {
      expect(getStringWidth('你好\n世界')).toBe(8); // newline has width 0
      expect(getStringWidth('a\nb')).toBe(2);
    });

    it('should handle fullwidth space', () => {
      expect(getStringWidth('　')).toBe(2); // 全角空格
      expect(getStringWidth('　　')).toBe(4); // 两个全角空格
      expect(getStringWidth('你好　世界')).toBe(10); // 2+2+2+2+2 = 10
    });
  });

  describe('getCharWidths', () => {
    it('should return correct widths array for CJK', () => {
      expect(getCharWidths('你好')).toEqual([2, 2]);
      expect(getCharWidths('测试')).toEqual([2, 2]);
    });

    it('should return correct widths array for mixed', () => {
      expect(getCharWidths('a中b')).toEqual([1, 2, 1]);
      expect(getCharWidths('Test！')).toEqual([1, 1, 1, 1, 2]);
    });

    it('should return correct widths array for fullwidth punctuation', () => {
      expect(getCharWidths('！？')).toEqual([2, 2]);
      expect(getCharWidths('，。')).toEqual([2, 2]);
    });
  });
});
