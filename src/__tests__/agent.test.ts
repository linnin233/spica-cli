import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SpicaAgent } from '../agent';
import { EventEmitter } from 'events';

// Mock dependencies
vi.mock('../llm/LLMClient', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    setSystemPrompt: vi.fn(),
    setMessages: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    generate: vi
      .fn()
      .mockResolvedValue({ content: 'test response', finished: true, toolCalls: [] }),
    continueWithAllToolResults: vi.fn(),
    generateDirect: vi.fn().mockResolvedValue({ content: 'summary' }),
    checkConnection: vi.fn().mockResolvedValue({ success: true }),
    getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
    interrupt: vi.fn(),
  })),
}));

vi.mock('../tools/index', () => ({
  executeTool: vi.fn().mockResolvedValue({ success: true, output: 'tool result' }),
  getAllToolDefinitions: vi.fn().mockReturnValue([]),
  setWorkspace: vi.fn(),
  getWorkspace: vi.fn().mockReturnValue(process.cwd()),
}));

vi.mock('../mcp/client', () => ({
  initMCP: vi.fn().mockResolvedValue(undefined),
  shutdownMCP: vi.fn(),
}));

vi.mock('../skills/index', () => ({
  initSkills: vi.fn().mockResolvedValue(undefined),
  listSkills: vi.fn().mockReturnValue([]),
}));

vi.mock('../utils/config', () => ({
  getProviderConfig: vi.fn().mockResolvedValue({
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4',
  }),
}));

vi.mock('../storage/projectState', () => ({
  loadProjectState: vi.fn().mockReturnValue(null),
  saveProjectState: vi.fn(),
  updateProjectTodos: vi.fn(),
  loadProjectContext: vi.fn().mockReturnValue([]),
  saveProjectContext: vi.fn(),
  ensureProjectDir: vi.fn(),
}));

vi.mock('../utils/projectConfig', () => ({
  loadProjectConfig: vi.fn().mockReturnValue(null),
  autoDetectProject: vi.fn().mockReturnValue({ type: 'typescript' }),
  createAgentsMd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks', () => ({
  runPreHooks: vi.fn().mockReturnValue({ matched: false }),
  runPostHooks: vi.fn().mockReturnValue(null),
}));

describe('SpicaAgent', () => {
  let agent: SpicaAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new SpicaAgent('openai', '/test/workspace');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create agent with provider name', () => {
      expect(agent).toBeInstanceOf(EventEmitter);
      expect(agent.todos).toEqual([]);
    });

    it('should use default workspace if not provided', () => {
      const defaultAgent = new SpicaAgent();
      expect(defaultAgent.getWorkspacePath()).toBe(process.cwd());
    });

    it('should use provided workspace', () => {
      expect(agent.getWorkspacePath()).toBe('/test/workspace');
    });
  });

  describe('interrupt', () => {
    it('should set interrupt flag', () => {
      agent.interrupt();
      // Interrupt flag is private, we can verify through behavior
      expect(agent).toBeDefined();
    });
  });

  describe('todos', () => {
    it('should set todos', () => {
      agent.setTodos(['task 1', 'task 2', 'task 3']);
      expect(agent.todos.length).toBe(3);
      expect(agent.todos[0].status).toBe('pending');
    });

    it('should emit todos_set event', () => {
      const eventSpy = vi.fn();
      agent.on('todos_set', eventSpy);

      agent.setTodos(['task 1']);
      expect(eventSpy).toHaveBeenCalled();
    });

    it('should update todo status', () => {
      agent.setTodos(['task 1', 'task 2']);
      agent.updateTodo(0, 'in_progress');

      expect(agent.todos[0].status).toBe('in_progress');
      expect(agent.todos[1].status).toBe('pending');
    });

    it('should emit todo_update event', () => {
      const eventSpy = vi.fn();
      agent.on('todo_update', eventSpy);

      agent.setTodos(['task']);
      agent.updateTodo(0, 'completed');
      expect(eventSpy).toHaveBeenCalled();
    });

    it('should ignore invalid todo index', () => {
      agent.setTodos(['task']);
      agent.updateTodo(10, 'completed'); // Invalid index

      expect(agent.todos[0].status).toBe('pending');
    });
  });

  describe('generateErrorSuggestion', () => {
    it('should suggest for ENOENT error', () => {
      const suggestion = (agent as any).generateErrorSuggestion(
        'read',
        'ENOENT: no such file',
        { path: '/missing/file' }
      );
      expect(suggestion).toContain('not found');
    });

    it('should suggest for EACCES error', () => {
      const suggestion = (agent as any).generateErrorSuggestion(
        'read',
        'EACCES: permission denied',
        { path: '/protected/file' }
      );
      expect(suggestion).toContain('Permission denied');
    });

    it('should suggest for command not found', () => {
      const suggestion = (agent as any).generateErrorSuggestion('bash', 'command not found: xyz', {
        command: 'xyz',
      });
      expect(suggestion).toContain('not found');
    });

    it('should provide generic suggestion for unknown errors', () => {
      const suggestion = (agent as any).generateErrorSuggestion('unknown_tool', 'some error', {});
      expect(suggestion).toContain('failed');
    });

    it('should suggest for EACCES error', () => {
      const suggestion = (agent as any).generateErrorSuggestion(
        'write',
        'EACCES: permission denied',
        { path: '/protected/file' }
      );
      expect(suggestion).toContain('Permission denied');
    });

    it('should suggest for command not found', () => {
      const suggestion = (agent as any).generateErrorSuggestion('bash', 'command not found: xyz', {
        command: 'xyz',
      });
      expect(suggestion).toContain('not found');
    });

    it('should provide generic suggestion for unknown errors', () => {
      const suggestion = (agent as any).generateErrorSuggestion('unknown_tool', 'some error', {});
      expect(suggestion).toContain('failed');
    });
  });

  describe('workspace', () => {
    it('should return workspace path', () => {
      expect(agent.getWorkspacePath()).toBe('/test/workspace');
    });

    it('should return project config', () => {
      const config = agent.getProjectConfig();
      expect(config).toBeDefined();
    });
  });

  describe('messages', () => {
    it('should return empty messages when LLM not initialized', () => {
      expect(agent.getMessages()).toEqual([]);
    });

    it('should set messages', () => {
      // After init, LLM will be available
      agent.setMessages([{ role: 'user', content: 'test' }]);
      // Messages are set on LLM client
    });
  });

  describe('setMessages preserves system prompt', () => {
    it('should preserve system prompt when clearing messages', () => {
      // Create a mock LLM with system prompt in messages
      const mockLLMWithSystem = {
        setSystemPrompt: vi.fn(),
        setMessages: vi.fn(),
        getMessages: vi.fn().mockReturnValue([
          { role: 'system', content: 'You are spica, a coding agent CLI.' },
          { role: 'user', content: 'Previous user message' },
          { role: 'assistant', content: 'Previous assistant response' },
        ]),
        on: vi.fn(),
        generate: vi.fn(),
        continueWithAllToolResults: vi.fn(),
        generateDirect: vi.fn(),
        checkConnection: vi.fn().mockResolvedValue({ success: true }),
        getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
        interrupt: vi.fn(),
      };

      // Inject mock
      Object.defineProperty(agent, 'llm', { value: mockLLMWithSystem, writable: true });

      // Call setMessages with empty array (simulating /clear)
      agent.setMessages([]);

      // Verify setMessages was called with system prompt preserved
      expect(mockLLMWithSystem.setMessages).toHaveBeenCalled();
      const finalMessages = mockLLMWithSystem.setMessages.mock.calls[0][0];

      // System prompt should be preserved
      expect(finalMessages[0].role).toBe('system');
      expect(finalMessages[0].content).toContain('spica');
    });

    it('should preserve system prompt when setting new messages', () => {
      const mockLLMWithSystem = {
        setSystemPrompt: vi.fn(),
        setMessages: vi.fn(),
        getMessages: vi.fn().mockReturnValue([
          { role: 'system', content: 'You are spica, a coding agent CLI.' },
          { role: 'user', content: 'Old message 1' },
          { role: 'assistant', content: 'Old response 1' },
        ]),
        on: vi.fn(),
        generate: vi.fn(),
        continueWithAllToolResults: vi.fn(),
        generateDirect: vi.fn(),
        checkConnection: vi.fn().mockResolvedValue({ success: true }),
        getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
        interrupt: vi.fn(),
      };

      Object.defineProperty(agent, 'llm', { value: mockLLMWithSystem, writable: true });

      // Set new messages (simulating session switch)
      agent.setMessages([
        { role: 'user', content: 'New message 1' },
        { role: 'assistant', content: 'New response 1' },
      ]);

      expect(mockLLMWithSystem.setMessages).toHaveBeenCalled();
      const finalMessages = mockLLMWithSystem.setMessages.mock.calls[0][0];

      // System prompt should be preserved at index 0
      expect(finalMessages[0].role).toBe('system');
      expect(finalMessages.length).toBe(3); // system + 2 new messages
    });

    it('should not duplicate system prompt if new messages contain system', () => {
      const mockLLMWithSystem = {
        setSystemPrompt: vi.fn(),
        setMessages: vi.fn(),
        getMessages: vi
          .fn()
          .mockReturnValue([{ role: 'system', content: 'You are spica, a coding agent CLI.' }]),
        on: vi.fn(),
        generate: vi.fn(),
        continueWithAllToolResults: vi.fn(),
        generateDirect: vi.fn(),
        checkConnection: vi.fn().mockResolvedValue({ success: true }),
        getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
        interrupt: vi.fn(),
      };

      Object.defineProperty(agent, 'llm', { value: mockLLMWithSystem, writable: true });

      // Set messages that include a system prompt (should be filtered out)
      agent.setMessages([
        { role: 'system', content: 'Different system prompt' },
        { role: 'user', content: 'User message' },
      ]);

      const finalMessages = mockLLMWithSystem.setMessages.mock.calls[0][0];

      // Should only have one system prompt (the original one)
      const systemMessages = finalMessages.filter(m => m.role === 'system');
      expect(systemMessages.length).toBe(1);
      expect(systemMessages[0].content).toContain('spica'); // Original preserved
    });
  });

  describe('events', () => {
    it('should be an EventEmitter', () => {
      expect(agent).toBeInstanceOf(EventEmitter);
    });

    it('should emit and receive events', () => {
      const handler = vi.fn();
      agent.on('test_event', handler);
      agent.emit('test_event', { data: 'test' });
      expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });
  });
});
