import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ── Minimal mocks ───────────────────────────────────────────────

vi.mock('../../llm/LLMClient', () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    setSystemPrompt: vi.fn(),
    setSystemPromptSplit: vi.fn(),
    setMessages: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
    addMessage: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    generate: vi.fn().mockResolvedValue({ content: 'ok', finished: true, toolCalls: [] }),
    continueWithAllToolResults: vi.fn(),
    generateDirect: vi.fn().mockResolvedValue({ content: 'summary' }),
    checkConnection: vi.fn().mockResolvedValue({ success: true }),
    getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
    getTokenCounter: vi.fn().mockReturnValue({
      setContextWindow: vi.fn(),
      estimateMessages: vi.fn().mockReturnValue(0),
      estimateTokens: vi.fn().mockReturnValue(0),
    }),
    getProviderName: vi.fn().mockReturnValue('openai'),
    interrupt: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../tools/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tools/index')>();
  return { ...actual, executeTool: vi.fn().mockResolvedValue({ success: true, output: 'ok' }) };
});

vi.mock('../../mcp/client', () => ({
  initMCP: vi.fn().mockResolvedValue(undefined),
  shutdownMCP: vi.fn(),
  getMCPManager: vi.fn().mockReturnValue({ getToolDefinitions: vi.fn().mockReturnValue([]) }),
}));
vi.mock('../../skills/index', () => ({ initSkills: vi.fn().mockResolvedValue(undefined), listSkills: vi.fn().mockReturnValue([]), getSkill: vi.fn().mockReturnValue(null), buildSkillPrompt: vi.fn().mockReturnValue('') }));
vi.mock('../../utils/settings', async (importOriginal) => { const actual = await importOriginal<typeof import('../../utils/settings')>(); return { ...actual, getProviderConfig: vi.fn().mockResolvedValue({ apiKey: 'test', baseUrl: 'https://test', model: 'gpt-4' }), resolveModel: vi.fn().mockReturnValue('gpt-4') }; });
vi.mock('../../storage/projectState', () => ({ loadProjectState: vi.fn().mockReturnValue(null), saveProjectState: vi.fn(), updateProjectTodos: vi.fn(), loadProjectContext: vi.fn().mockReturnValue([]), saveProjectContext: vi.fn(), ensureProjectDir: vi.fn() }));
vi.mock('../../utils/projectConfig', () => ({ loadProjectConfig: vi.fn().mockReturnValue(null), autoDetectProject: vi.fn().mockReturnValue({ type: 'typescript' }), createAgentsMd: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/session', () => ({ loadSession: vi.fn().mockReturnValue({ messages: [] }), saveSession: vi.fn() }));
vi.mock('../../prompts/system', async (importOriginal) => { const actual = await importOriginal<typeof import('../../prompts/system')>(); return { ...actual, getSystemPromptStable: vi.fn().mockReturnValue('stable prompt'), getSystemPromptVariable: vi.fn().mockReturnValue('') }; });

// ── Real imports ────────────────────────────────────────────────

import { SpicaAgent } from '../../agent';
import { executeTask } from '../impl/task';
import { executeReplySubagent } from '../impl/replySubagent';
import { getBackgroundTaskIds } from '../impl/task';

describe('non-blocking subagent integration', () => {
  let parentAgent: SpicaAgent;

  beforeEach(async () => {
    vi.clearAllMocks();

    parentAgent = new SpicaAgent(undefined, '/tmp/test-project');
    await parentAgent.init();
    parentAgent.stateMachine.transition('idle');
  });

  it('non-blocking task returns immediately with task IDs', async () => {
    const result = await executeTask(
      { tasks: [{ description: 'test', prompt: 'Do something' }], blocking: false },
      (event, data) => parentAgent.emit(event, data)
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Dispatched');
    expect(result.output).toMatch(/bg-\d+/);
  });

  it('emits sub_agent_start and sub_agent_done for background task', async () => {
    const events: string[] = [];

    parentAgent.on('sub_agent_start', () => events.push('start'));
    parentAgent.on('sub_agent_done', () => events.push('done'));

    await executeTask(
      { tasks: [{ description: 'quick', prompt: 'Test', type: 'explore' }], blocking: false },
      (event, data) => parentAgent.emit(event, data)
    );

    await vi.waitFor(
      () => {
        expect(events).toContain('start');
        expect(events).toContain('done');
      },
      { timeout: 10000 }
    );
  });

  it('background task cleaned from registry after completion', async () => {
    const donePromise = new Promise<void>((resolve) => {
      parentAgent.on('sub_agent_done', () => resolve());
    });

    await executeTask(
      { tasks: [{ description: 'test', prompt: 'Test', type: 'explore' }], blocking: false },
      (event, data) => parentAgent.emit(event, data)
    );

    await vi.waitFor(() => donePromise, { timeout: 10000 });

    expect(getBackgroundTaskIds().length).toBe(0);
  });

  it('emits sub_agent_question when LLM returns NEEDS_CONTEXT', async () => {
    // Override mock to return NEEDS_CONTEXT
    const { LLMClient } = await import('../../llm/LLMClient');
    (LLMClient as any).mockImplementation(() => ({
      setSystemPrompt: vi.fn(),
      setSystemPromptSplit: vi.fn(),
      setMessages: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
      addMessage: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        content: 'NEEDS_CONTEXT: user or system level?',
        finished: true,
        toolCalls: [],
      }),
      continueWithAllToolResults: vi.fn(),
      generateDirect: vi.fn().mockResolvedValue({ content: 'summary' }),
      checkConnection: vi.fn().mockResolvedValue({ success: true }),
      getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
      getTokenCounter: vi.fn().mockReturnValue({
        setContextWindow: vi.fn(),
        estimateMessages: vi.fn().mockReturnValue(0),
        estimateTokens: vi.fn().mockReturnValue(0),
      }),
      getProviderName: vi.fn().mockReturnValue('openai'),
      interrupt: vi.fn(),
      dispose: vi.fn(),
    }));

    const questionEvents: any[] = [];
    parentAgent.on('sub_agent_question', (d: any) => questionEvents.push(d));

    await executeTask(
      { tasks: [{ description: 'ask', prompt: 'Install hooks', type: 'build' }], blocking: false },
      (event, data) => parentAgent.emit(event, data)
    );

    await vi.waitFor(
      () => expect(questionEvents.length).toBe(1),
      { timeout: 10000 }
    );

    expect(questionEvents[0].question).toContain('NEEDS_CONTEXT');
  });
});

describe('question/reply flow', () => {
  let parentAgent: SpicaAgent;

  beforeEach(async () => {
    vi.clearAllMocks();

    parentAgent = new SpicaAgent(undefined, '/tmp/test-project');
    await parentAgent.init();
    parentAgent.stateMachine.transition('idle');
  });

  // Wait for any lingering background tasks from previous tests
  afterEach(async () => {
    const ids = getBackgroundTaskIds();
    if (ids.length > 0) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (getBackgroundTaskIds().length === 0) {
            clearInterval(check);
            resolve();
          }
        }, 100);
        setTimeout(() => { clearInterval(check); resolve(); }, 5000);
      });
    }
  });

  it('reply_subagent resolves question and subagent continues', async () => {
    let callCount = 0;
    const { LLMClient } = await import('../../llm/LLMClient');
    (LLMClient as any).mockImplementation(() => ({
      setSystemPrompt: vi.fn(),
      setSystemPromptSplit: vi.fn(),
      setMessages: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
      addMessage: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      generate: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(
          callCount === 1
            ? { content: 'NEEDS_CONTEXT: user or system?', finished: true, toolCalls: [] }
            : { content: 'Done - installed at user level.', finished: true, toolCalls: [] }
        );
      }),
      continueWithAllToolResults: vi.fn(),
      generateDirect: vi.fn().mockResolvedValue({ content: 'summary' }),
      checkConnection: vi.fn().mockResolvedValue({ success: true }),
      getProvider: vi.fn().mockReturnValue({ getContextWindow: vi.fn().mockReturnValue(128000) }),
      getTokenCounter: vi.fn().mockReturnValue({
        setContextWindow: vi.fn(),
        estimateMessages: vi.fn().mockReturnValue(0),
        estimateTokens: vi.fn().mockReturnValue(0),
      }),
      getProviderName: vi.fn().mockReturnValue('openai'),
      interrupt: vi.fn(),
      dispose: vi.fn(),
    }));

    const events: string[] = [];
    parentAgent.on('sub_agent_question', () => events.push('question'));
    parentAgent.on('sub_agent_done', () => events.push('done'));

    const result = await executeTask(
      { tasks: [{ description: 'hooks', prompt: 'Install hooks', type: 'build' }], blocking: false },
      (event, data) => parentAgent.emit(event, data)
    );

    expect(result.success).toBe(true);

    // Wait for question event
    await vi.waitFor(() => expect(events).toContain('question'), { timeout: 10000 });

    // Find the background task ID and reply
    const bgIds = getBackgroundTaskIds();
    expect(bgIds.length).toBeGreaterThanOrEqual(1);

    const replyResult = await executeReplySubagent({
      task_id: bgIds[bgIds.length - 1],
      answer: 'user level (~/.config/)',
    });
    expect(replyResult.success).toBe(true);

    // Subagent should continue and finish
    await vi.waitFor(() => expect(events).toContain('done'), { timeout: 10000 });
    expect(events).toEqual(['question', 'done']);
  });
});
