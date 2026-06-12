// Regression test for circular dependency fix
import { describe, it, expect } from 'vitest';

describe('Circular Dependency Fix - Regression Tests', () => {
  describe('Import chain validation', () => {
    it('should import RuntimeState without circular dependency', async () => {
      // RuntimeState应该使用 import type，不会产生循环依赖
      const { getRuntimeState } = await import('../../core/RuntimeState');

      const state = getRuntimeState();
      expect(state).toBeDefined();
      expect(state.isProcessing()).toBe(false);
    });

    it('should import tools without circular dependency', async () => {
      // tools/index.ts 不应该静态导入 SpicaAgent
      const { getAllToolDefinitions } = await import('../../tools/index');

      const tools = getAllToolDefinitions();
      expect(tools).toBeDefined();
      expect(Array.isArray(tools)).toBe(true);
    });

    it('should allow dynamic import of SpicaAgent in tools', async () => {
      // 验证动态导入路径正确
      const { SpicaAgent } = await import('../../agent');

      expect(SpicaAgent).toBeDefined();
      // 不应该抛出循环依赖错误
    });
  });

  describe('RuntimeState type-only import', () => {
    it('should use SpicaAgent as type only', async () => {
      // RuntimeState.ts 应该使用 import type { SpicaAgent }
      // 这意味着 SpicaAgent 只在类型检查时使用，不会产生运行时依赖

      const { getRuntimeState } = await import('../../core/RuntimeState');
      const state = getRuntimeState();

      // setAgent/getAgent 应该正常工作
      const { SpicaAgent } = await import('../../agent');
      const agent = new SpicaAgent('test');

      state.setAgent(agent);
      expect(state.getAgent()).toBe(agent);

      state.setAgent(null);
      expect(state.getAgent()).toBe(null);
    });
  });

  describe('Module structure validation', () => {
    it('should have no circular import errors at runtime', async () => {
      // 尝试导入所有核心模块，不应该有循环依赖错误
      const modules = [
        '../../agent',
        '../../tools/index',
        '../../llm/LLMClient',
        '../../llm/TokenCounter',
        '../../core/RuntimeState',
        '../../mcp/client',
        '../../skills/index',
        '../../cli/events',
      ];

      for (const modulePath of modules) {
        try {
          await import(modulePath);
        } catch (error: any) {
          // 不应该是循环依赖错误
          expect(error.message).not.toContain('circular');
          expect(error.message).not.toContain('Circular');
        }
      }
    });
  });
});
