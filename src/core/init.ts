import { SpicaAgent } from '../agent';
import { LLMClient } from '../llm/LLMClient';
import { initMCP } from '../mcp/client';
import { initSkills, listSkills } from '../skills/index';
import { getProviderConfig, resolveModel } from '../utils/settings';
import { getSystemPromptStable, getSystemPromptVariable, SUB_AGENT_SYSTEM_PROMPT } from '../prompts/system';
import {
  loadProjectConfig as loadAgentsConfig,
  autoDetectProject,
  createAgentsMd,
} from '../utils/projectConfig';
import { loadSession } from '../utils/session';
import { loadProjectState, ensureProjectDir } from '../storage/projectState';

export async function initAgent(agent: SpicaAgent): Promise<void> {
  if (agent.isInitialized()) return;
  const existingPromise = agent.getInitPromise();
  if (existingPromise) return existingPromise;

  agent.stateMachine.transition('initializing');
  agent.setInitPromise(doInit(agent));
  try {
    await agent.getInitPromise();
    agent.setInitialized(true);
    agent.stateMachine.transition('idle');
  } catch (e) {
    agent.stateMachine.transition('uninitialized');
    throw e;
  } finally {
    agent.setInitPromise(null);
  }
}

export async function initAgentAsSubAgent(
  agent: SpicaAgent,
  parentAgent: SpicaAgent,
  modelOverride?: string
): Promise<void> {
  if (agent.isInitialized()) return;

  agent.stateMachine.transition('initializing');

  const parentProviderName =
    parentAgent.getProviderName() || agent.getProviderName();
  const config = await getProviderConfig(parentProviderName);

  // Fresh LLM client — same API, isolated message history
  // If modelOverride specified, resolve it against provider's models map
  // (e.g., "haiku" → "claude-haiku-4-5", or direct model ID passed through)
  const resolvedModel = resolveModel(config, modelOverride);
  const newLlm = new LLMClient({
    provider: parentProviderName || 'openai',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: resolvedModel,
    name: config.name,
  });
  agent.setLLM(newLlm);

  // Minimal subagent system prompt — ~500 tokens vs ~5000+ for full prompt.
  // Subagent doesn't need CLAUDE.md, CLI commands, skills metadata, etc.
  newLlm.setSystemPrompt(SUB_AGENT_SYSTEM_PROMPT);

  // Inject recent context summary — so sub-agent knows what's happening
  const parentMessages = parentAgent.getLLM()?.getMessages() || [];
  const recentUserMessages = parentMessages
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => (m.content || '').slice(0, 300));
  const recentAssistantActions = parentMessages
    .filter(m => m.role === 'assistant' && m.toolCalls)
    .slice(-5)
    .map(m => {
      const tools = m.toolCalls?.map(tc => tc.name).join(', ') || '';
      const content = (m.content || '').slice(0, 120);
      return `[${tools}] ${content}`;
    });

  if (recentUserMessages.length > 0 || recentAssistantActions.length > 0) {
    const contextParts: string[] = [
      '[SUB-AGENT CONTEXT] You are a sub-agent working on part of a larger task.',
    ];
    if (recentUserMessages.length > 0) {
      contextParts.push(
        `Recent user requests:\n${recentUserMessages.map(m => `- ${m}`).join('\n')}`
      );
    }
    if (recentAssistantActions.length > 0) {
      contextParts.push(
        `Recent actions taken:\n${recentAssistantActions.map(a => `- ${a}`).join('\n')}`
      );
    }
    const parentTodos = agent.getTodosInternal();
    if (parentTodos.length > 0) {
      const pendingTodos = parentTodos.filter(t => t.status !== 'completed').slice(0, 5);
      if (pendingTodos.length > 0) {
        contextParts.push(
          `Current todos:\n${pendingTodos.map(t => `- [${t.status}] ${t.content}`).join('\n')}`
        );
      }
    }
    newLlm.addMessage({
      role: 'system',
      content: contextParts.join('\n\n'),
    });
  }

  // Inherit workspace and todos from parent
  agent.setWorkspacePathInternal(parentAgent.getWorkspacePath());
  agent.setTodosInternal([...parentAgent.todos]);

  // Setup stream forwarding
  newLlm.on('chunk', (chunk: string) => {
    agent.emit('stream', { chunk });
  });
  newLlm.on('reasoning', (content: string) => {
    // Set reasoningReceived on the agent
    (agent as any).reasoningReceived = true;
    agent.emit('reasoning', { content });
  });

  agent.setInitialized(true);
  agent.stateMachine.transition('idle');
}

export async function doInit(agent: SpicaAgent): Promise<void> {
  // 初始化Skills（首次运行时复制默认包）
  await initSkills();

  // 初始化MCP服务器连接
  try {
    await initMCP();
  } catch {
    console.log('MCP init skipped (no config or servers unavailable)');
  }

  const providerName = agent.getProviderName();
  const config = await getProviderConfig(providerName);
  const newLlm = new LLMClient({
    provider: providerName || 'openai',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    name: config.name,
  });
  agent.setLLM(newLlm);

  // 检查API连接
  const connectionResult = await newLlm.checkConnection();

  if (!connectionResult.success) {
    agent.emit('connection_error', {
      type: connectionResult.type,
      error: connectionResult.error,
      hint: connectionResult.hint,
      provider: providerName,
      model: config.model,
    });
    throw new Error(
      `API connection failed: ${connectionResult.type}\n${connectionResult.hint}\nDetails: ${connectionResult.error}`
    );
  }

  const workspacePath = agent.getWorkspacePathInternal();
  ensureProjectDir(workspacePath);

  // 从session文件加载完整历史（不是损坏的context.json）
  const session = loadSession(workspacePath);
  if (session && session.messages.length > 0) {
    // session.messages已经通过cleanMessages清理过了
    newLlm.setMessages(session.messages);
    agent.setFullHistory([...session.messages]);
    agent.setLastSyncedProviderIndex(newLlm.getMessages().length - 1);
  }

  // Restore ProgressTracker from session (survives restarts)
  if (session?.progress?.entries?.length) {
    agent.restoreProgress(session.progress as any);
  }

  const projectState = loadProjectState(workspacePath);
  if (projectState) {
    agent.setTodosInternal(projectState.todos);
  }

  await loadProjectConfig(agent);

  // Build skills metadata for system prompt
  const skills = listSkills(workspacePath);
  const skillsMetadata = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');

  const projectConfig = agent.getProjectConfigInternal();
  const stablePrompt = getSystemPromptStable(projectConfig);
  const variablePrompt = getSystemPromptVariable(skillsMetadata, workspacePath);
  newLlm.setSystemPromptSplit(stablePrompt, variablePrompt);

  newLlm.on('chunk', (chunk: string) => {
    agent.emit('stream', { chunk });
  });

  // 追踪 reasoning 状态，用于判断真正的空响应
  newLlm.on('reasoning', (content: string) => {
    (agent as any).reasoningReceived = true;
    agent.emit('reasoning', { content });
  });

  agent.emit('initialized', {
    model: config.model,
    project: projectConfig,
  });
}

export async function loadProjectConfig(agent: SpicaAgent): Promise<void> {
  const workspacePath = agent.getWorkspacePathInternal();

  // 使用新的 projectConfig.ts（兼容多种格式）
  const loadedConfig = loadAgentsConfig(workspacePath);

  if (loadedConfig) {
    agent.setProjectConfigInternal(loadedConfig);
    agent.emit('projectLoaded', loadedConfig);
  } else {
    // 无配置文件，自动检测并创建 AGENTS.md
    const autoConfig = autoDetectProject(workspacePath);
    agent.setProjectConfigInternal(autoConfig);
    await createAgentsMd(workspacePath);
    agent.emit('projectCreated', autoConfig);
  }
}

/**
 * Rebuild the system prompt after skills change (install/uninstall/add/remove/edit).
 * Reloads skills from disk and updates the LLM's split-prefix prompt.
 * Must be called after any skill modification so the LLM sees the updated list immediately.
 */
export function rebuildSystemPrompt(agent: SpicaAgent): void {
  const llm = agent.getLLM();
  if (!llm) return;

  const workspacePath = agent.getWorkspacePathInternal();
  const skills = listSkills(workspacePath);
  const skillsMetadata = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  const projectConfig = agent.getProjectConfigInternal();
  const stablePrompt = getSystemPromptStable(projectConfig);
  const variablePrompt = getSystemPromptVariable(skillsMetadata, workspacePath);
  llm.setSystemPromptSplit(stablePrompt, variablePrompt);
}
