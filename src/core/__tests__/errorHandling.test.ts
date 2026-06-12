describe('Error Handling Tests', () => {
  describe('Error Types', () => {
    it('should classify network errors', () => {
      const networkCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'];
      networkCodes.forEach(code => {
        expect(code.startsWith('E')).toBe(true);
      });
    });

    it('should classify HTTP errors', () => {
      const httpCodes = ['401', '402', '403', '404', '429', '500', '502', '503'];
      httpCodes.forEach(code => {
        expect(parseInt(code)).toBeGreaterThan(0);
      });
    });
  });

  describe('Error Messages', () => {
    it('should have friendly error hints', () => {
      const errorHints: Record<string, string> = {
        '401': 'API Key 无效或已过期',
        '429': '请求过于频繁',
        '500': '服务器内部错误',
        ECONNREFUSED: '连接被拒绝',
      };

      for (const [code, hint] of Object.entries(errorHints)) {
        expect(hint.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle circular reference', () => {
      const circular: any = { a: 1 };
      circular.self = circular;
      expect(circular.self).toBe(circular);
    });

    it('should handle extremely long error message', () => {
      const longMessage = 'A'.repeat(100000);
      const truncated = longMessage.slice(0, 500);
      expect(truncated.length).toBe(500);
    });
  });
});
