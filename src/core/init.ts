import { SpicaAgent } from '../agent';
import { LLMClient } from '../llm/LLMClient';
import { initMCP } from '../mcp/client';
import { initSkills, listSkills } from '../skills/index';
import { getProviderConfig } from '../utils/settings';
import { getSystemPromptStable, getSystemPromptVariable } from '../prompts/system';
import {
  loadProjectConfig as loadAgentsConfig,
  autoDetectProject,
  createAgentsMd,
} from '../utils/projectConfig';
import { loadSession } from '../utils/session';
import { loadProjectState, ensureProjectDir } from '../storage/projectState';

export async function initAgent(agent: SpicaAgent): Promise<void> {
  const self = agent as any;
  if (self._initialized) return;
  if (self._initPromise) return self._initPromise;

  self._initPromise = doInit(agent);
  try {
    await self._initPromise;
    self._initialized = true;
  } finally {
    self._initPromise = null;
  }
}

export async function initAgentAsSubAgent(
  agent: SpicaAgent,
  parentAgent: SpicaAgent
): Promise<void> {
  const self = agent as any;
  if (self._initialized) return;

  const parentProviderName =
    (parentAgent as any)._providerName || self._providerName;
  const config = await getProviderConfig(parentProviderName);

  // Fresh LLM client — same API, isolated message history
  self.llm = new LLMClient({
    provider: parentProviderName || 'openai',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    name: config.name,
  });

  // Inherit system prompt from parent
  const parentMessages = parentAgent.getLLM()?.getMessages() || [];
  const parentSystemMsg = parentMessages.find(m => m.role === 'system');
  if (parentSystemMsg?.content) {
    self.llm.setSystemPrompt(parentSystemMsg.content);
  }

  // Inject recent context summary — so sub-agent knows what's happening
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
    if (self._todos.length > 0) {
      const pendingTodos = self._todos.filter(t => t.status !== 'completed').slice(0, 5);
      if (pendingTodos.length > 0) {
        contextParts.push(
          `Current todos:\n${pendingTodos.map(t => `- [${t.status}] ${t.content}`).join('\n')}`
        );
      }
    }
    self.llm.addMessage({
      role: 'system',
      content: contextParts.join('\n\n'),
    });
  }

  // Inherit workspace and todos from parent
  self.workspacePath = parentAgent.getWorkspacePath();
  self._todos = [...parentAgent.todos];

  // Setup stream forwarding
  self.llm.on('chunk', (chunk: string) => {
    agent.emit('stream', { chunk });
  });
  self.llm.on('reasoning', (content: string) => {
    self.reasoningReceived = true;
    agent.emit('reasoning', { content });
  });

  self._initialized = true;
}

export async function doInit(agent: SpicaAgent): Promise<void> {
  const self = agent as any;

  // 初始化Skills（首次运行时复制默认包）
  await initSkills();

  // 初始化MCP服务器连接
  try {
    await initMCP();
  } catch {
    console.log('MCP init skipped (no config or servers unavailable)');
  }

  const config = await getProviderConfig(self._providerName);
  self.llm = new LLMClient({
    provider: self._providerName || 'openai',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    name: config.name,
  });

  // 检查API连接
  const connectionResult = await self.llm.checkConnection();

  if (!connectionResult.success) {
    agent.emit('connection_error', {
      type: connectionResult.type,
      error: connectionResult.error,
      hint: connectionResult.hint,
      provider: self._providerName,
      model: config.model,
    });
    throw new Error(
      `API connection failed: ${connectionResult.type}\n${connectionResult.hint}\nDetails: ${connectionResult.error}`
    );
  }

  ensureProjectDir(self.workspacePath);

  // 从session文件加载完整历史（不是损坏的context.json）
  const session = loadSession(self.workspacePath);
  if (session && session.messages.length > 0) {
    // session.messages已经通过cleanMessages清理过了
    self.llm.setMessages(session.messages);
    self._fullHistory = [...session.messages];
    self._lastSyncedProviderIndex = self.llm.getMessages().length - 1;
  }

  const projectState = loadProjectState(self.workspacePath);
  if (projectState) {
    self._todos = projectState.todos;
  }

  await loadProjectConfig(agent);

  // Build skills metadata for system prompt
  const skills = listSkills(self.workspacePath);
  const skillsMetadata = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');

  const stablePrompt = getSystemPromptStable(self.projectConfig);
  const variablePrompt = getSystemPromptVariable(skillsMetadata, self.workspacePath);
  self.llm.setSystemPromptSplit(stablePrompt, variablePrompt);

  self.llm.on('chunk', (chunk: string) => {
    agent.emit('stream', { chunk });
  });

  // 追踪 reasoning 状态，用于判断真正的空响应
  self.llm.on('reasoning', (content: string) => {
    self.reasoningReceived = true;
    agent.emit('reasoning', { content });
  });

  agent.emit('initialized', {
    model: config.model,
    project: self.projectConfig,
  });
}

export async function loadProjectConfig(agent: SpicaAgent): Promise<void> {
  const self = agent as any;

  // 使用新的 projectConfig.ts（兼容多种格式）
  const loadedConfig = loadAgentsConfig(self.workspacePath);

  if (loadedConfig) {
    self.projectConfig = loadedConfig;
    agent.emit('projectLoaded', self.projectConfig);
  } else {
    // 无配置文件，自动检测并创建 AGENTS.md
    const autoConfig = autoDetectProject(self.workspacePath);
    self.projectConfig = autoConfig;
    await createAgentsMd(self.workspacePath);
    agent.emit('projectCreated', autoConfig);
  }
}
