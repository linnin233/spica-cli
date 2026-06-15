// Settings 系统 - 统一管理所有配置
// 全局 settings.json 包含 providers, mcp, skills, hooks
// 项目 .spica/ 只放 session.json 和可选的 skills.json/hooks.json

import fs from 'fs-extra';
import { homedir } from 'os';
import { join } from 'path';

// 全局配置目录
export const GLOBAL_DIR = join(homedir(), '.spica');
export const GLOBAL_SETTINGS_FILE = join(GLOBAL_DIR, 'settings.json');

// Provider 配置
export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;                    // 默认模型
  models?: Record<string, string>;  // 模型别名 → model ID, e.g. { "haiku": "claude-haiku-4-5", "mini": "gpt-4o-mini" }
  description?: string;
}

/**
 * Resolve a model alias to its actual model ID.
 * 1. If alias matches a key in provider's models map → return the mapped model ID
 * 2. If alias looks like a real model ID (contains '/', '-', digits) → return as-is
 * 3. Otherwise fall back to provider's default model
 */
export function resolveModel(provider: ProviderConfig, modelAlias?: string): string {
  if (!modelAlias) return provider.model;

  // Check models alias map first
  if (provider.models && provider.models[modelAlias]) {
    return provider.models[modelAlias];
  }

  // If it looks like a real model ID (contains version-like patterns), use as-is
  if (/[-\d]/.test(modelAlias) || modelAlias.includes('/')) {
    return modelAlias;
  }

  // Fall back to default model
  return provider.model;
}

/**
 * List available model aliases for a provider.
 * Returns null if no models map is configured.
 */
export function listProviderModels(provider: ProviderConfig): string[] | null {
  if (!provider.models || Object.keys(provider.models).length === 0) return null;
  return Object.entries(provider.models).map(([alias, id]) => `${alias} → ${id}`);
}

// MCP 配置
export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
}

// Skills 配置
export interface SkillDefinition {
  name?: string;
  description: string;
  promptTemplate: string;
  allowedTools?: string[];
  timeout?: number;
  autoInvoke?: boolean; // 是否允许AI自动调用
  paths?: string[]; // 路径匹配
  argumentHint?: string; // 参数提示，如 "[name]"
}

// Hooks 配置
export interface HookMatcher {
  tool?: string;
  args?: Record<string, string>;
}

export interface HookDefinition {
  matcher: HookMatcher;
  action: 'block' | 'confirm' | 'log' | 'warn';
  message: string;
}

export interface HookResult {
  matched: boolean;
  action: 'block' | 'confirm' | 'log' | 'warn' | 'none';
  message: string;
}

// 统一 Settings 结构
export interface Settings {
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  mcp?: {
    servers: MCPServerConfig[];
  };
  skills?: Record<string, SkillDefinition>;
  hooks?: {
    PreToolUse?: HookDefinition[];
    PostToolUse?: HookDefinition[];
  };
}

export const DEFAULT_BASE_URLS: Record<string, string> = {};

const DEFAULT_MODELS: Record<string, string> = {};

// 默认安全 hooks（运行时使用，不写入配置文件）
const DEFAULT_HOOKS: Settings['hooks'] = {
  PreToolUse: [
    {
      matcher: { tool: 'bash', args: { command: '*--force*' } },
      action: 'block',
      message: '禁止使用 --force 参数',
    },
    {
      matcher: { tool: 'bash', args: { command: '*rm -rf /*' } },
      action: 'block',
      message: '禁止删除根目录',
    },
  ],
};

let settingsCache: Settings | null = null;

// 内置 MCP 服务器（首次运行时自动配置）
const BUILTIN_MCP_SERVERS: MCPServerConfig[] = [
  {
    name: 'playwright',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
  },
];

export async function loadGlobalSettings(): Promise<Settings> {
  await fs.ensureDir(GLOBAL_DIR);

  if (!(await fs.pathExists(GLOBAL_SETTINGS_FILE))) {
    // 首次运行：写入内置 MCP 配置
    const defaultSettings: Settings = {
      mcp: {
        servers: BUILTIN_MCP_SERVERS,
      },
    };
    await fs.writeJson(GLOBAL_SETTINGS_FILE, defaultSettings, { spaces: 2 });
    settingsCache = defaultSettings;
    return settingsCache;
  }

  const loaded = (await fs.readJson(GLOBAL_SETTINGS_FILE)) as Settings;

  // 确保内置 MCP 存在（用户可能手动删除了）
  if (!loaded.mcp?.servers?.some(s => s.name === 'playwright')) {
    loaded.mcp = {
      servers: [...(loaded.mcp?.servers || []), ...BUILTIN_MCP_SERVERS],
    };
    await fs.writeJson(GLOBAL_SETTINGS_FILE, loaded, { spaces: 2 });
  }

  settingsCache = loaded;
  return loaded;
}

export async function saveGlobalSettings(settings: Settings): Promise<void> {
  await fs.ensureDir(GLOBAL_DIR);

  // 记录保存操作的来源（调试用）
  const caller = new Error().stack?.split('\n')[2] || 'unknown';
  const auditPath = join(GLOBAL_DIR, 'settings_audit.log');
  const entry = `[${new Date().toISOString()}] saveGlobalSettings called from: ${caller}\n`;
  await fs.appendFile(auditPath, entry);

  await fs.writeJson(GLOBAL_SETTINGS_FILE, settings, { spaces: 2 });

  if (process.platform !== 'win32') {
    await fs.chmod(GLOBAL_SETTINGS_FILE, 0o600);
    await fs.chmod(GLOBAL_DIR, 0o700);
  }

  // 确保 .gitignore 保护 settings.json（防止意外提交 API keys）
  const gitignorePath = join(GLOBAL_DIR, '.gitignore');
  if (!(await fs.pathExists(gitignorePath))) {
    await fs.writeFile(
      gitignorePath,
      '# Protect API keys from accidental commit\nsettings.json\naudit.log\n',
      'utf-8'
    );
  }

  settingsCache = settings;
}

// 加载项目 skills (覆盖全局)
export function loadProjectSkills(workspacePath: string): Record<string, SkillDefinition> | null {
  const skillsDir = join(workspacePath, '.spica', 'skills');
  const projectSkillsPath = join(workspacePath, '.spica', 'skills.json');

  const skills: Record<string, SkillDefinition> = {};

  // 方式1: 从 skills.json 文件加载
  if (fs.existsSync(projectSkillsPath)) {
    try {
      const projectSkills = fs.readJsonSync(projectSkillsPath);
      Object.assign(skills, projectSkills.skills || projectSkills);
    } catch {}
  }

  // 方式2: 从 skills/ 目录扫描（支持 superpowers 安装方式）
  if (fs.existsSync(skillsDir)) {
    try {
      const dirs = fs.readdirSync(skillsDir).filter(d => {
        const fullPath = join(skillsDir, d);
        return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
      });

      for (const dir of dirs) {
        const skillFile = join(skillsDir, dir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          try {
            const content = fs.readFileSync(skillFile, 'utf-8');
            // 从 SKILL.md 解析 skill 定义
            const skillDef = parseSkillMarkdown(dir, content);
            if (skillDef) {
              skills[dir] = skillDef;
            }
          } catch {}
        }
      }
    } catch {}
  }

  return Object.keys(skills).length > 0 ? skills : null;
}

// 解析 SKILL.md 文件提取 skill 定义
function parseSkillMarkdown(name: string, content: string): SkillDefinition | null {
  // 提取 description（第一个段落）
  const lines = content.split('\n');
  let description = '';
  let promptTemplate = '';

  // 找到标题后的第一个非空段落作为 description
  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      foundTitle = true;
      continue;
    }
    if (foundTitle && line.trim()) {
      description = line.trim();
      break;
    }
  }

  // 整个内容作为 promptTemplate（LLM 会处理）
  promptTemplate = content;

  return {
    name,
    description: description || `Skill: ${name}`,
    promptTemplate,
  };
}

// 加载项目 hooks (追加全局)
export function loadProjectHooks(workspacePath: string): Settings['hooks'] | null {
  const projectHooksPath = join(workspacePath, '.spica', 'hooks.json');

  if (fs.existsSync(projectHooksPath)) {
    try {
      const projectHooks = fs.readJsonSync(projectHooksPath);
      return projectHooks.hooks || projectHooks;
    } catch {
      return null;
    }
  }
  return null;
}

// 合并全局 + 项目配置
export async function loadEffectiveSettings(workspacePath: string): Promise<Settings> {
  const global = await loadGlobalSettings();

  // 项目 skills 覆盖全局
  const projectSkills = loadProjectSkills(workspacePath);
  const effectiveSkills = projectSkills || global.skills;

  // 项目 hooks 追加全局（如果没有配置，使用默认安全 hooks）
  const projectHooks = loadProjectHooks(workspacePath);
  let effectiveHooks = global.hooks || DEFAULT_HOOKS;

  if (projectHooks) {
    effectiveHooks = {
      PreToolUse: [...(effectiveHooks?.PreToolUse || []), ...(projectHooks.PreToolUse || [])],
      PostToolUse: [...(effectiveHooks?.PostToolUse || []), ...(projectHooks.PostToolUse || [])],
    };
  }

  return {
    ...global,
    skills: effectiveSkills,
    hooks: effectiveHooks,
  };
}

// Provider 相关函数
export async function getProviderConfig(providerName?: string): Promise<ProviderConfig> {
  const settings = await loadGlobalSettings();
  const name = providerName || settings.defaultProvider || 'default';

  const fileConfig = settings.providers?.[name];

  const upperName = name.toUpperCase().replace(/-/g, '_');
  const envApiKey =
    process.env[`SPICA_${upperName}_API_KEY`] ||
    process.env[`${upperName}_API_KEY`] ||
    process.env.OPENAI_API_KEY;

  const envModel =
    process.env[`SPICA_${upperName}_MODEL`] ||
    process.env[`${upperName}_MODEL`] ||
    process.env.MODEL;

  const envBaseUrl =
    process.env[`SPICA_${upperName}_BASE_URL`] ||
    process.env[`${upperName}_BASE_URL`] ||
    process.env.OPENAI_BASE_URL;

  const apiKey = envApiKey || fileConfig?.apiKey;
  const model = envModel || fileConfig?.model || DEFAULT_MODELS[name] || 'gpt-4o';

  // Validate baseUrl - must be a valid URL
  let baseUrl = envBaseUrl || fileConfig?.baseUrl;

  // Check if baseUrl is a valid URL format (if provided)
  if (baseUrl && baseUrl.trim() !== '') {
    try {
      new URL(baseUrl);
    } catch {
      throw new Error(
        `Provider '${name}' has invalid baseUrl '${baseUrl}'. Fix with: spica providers set ${name} <api-key> --url https://api.example.com/v1 --model <model>`
      );
    }
  } else {
    // Use default if not provided
    baseUrl = DEFAULT_BASE_URLS[name] || 'https://api.openai.com/v1';
  }

  if (!apiKey) {
    throw new Error(
      `Provider '${name}' not configured. Run: spica providers set ${name} <api-key> --url <base-url> --model <model-name>`
    );
  }

  return {
    name: fileConfig?.name || name,
    apiKey,
    baseUrl,
    model,
    models: fileConfig?.models,
    description: fileConfig?.description,
  };
}

export async function setProviderConfig(
  name: string,
  apiKey: string,
  baseUrl?: string,
  model?: string,
  models?: Record<string, string>
): Promise<void> {
  const settings = await loadGlobalSettings();

  if (!settings.providers) settings.providers = {};

  const existing = settings.providers[name];
  settings.providers[name] = {
    name,
    apiKey,
    baseUrl: baseUrl || existing?.baseUrl || DEFAULT_BASE_URLS[name] || '',
    model: model || existing?.model || DEFAULT_MODELS[name] || 'gpt-4o',
    models: models || existing?.models,
    description: existing?.description,
  };

  if (!settings.defaultProvider) {
    settings.defaultProvider = name;
  }

  await saveGlobalSettings(settings);
}

/** Set model aliases for a provider */
export async function setProviderModels(
  providerName: string,
  models: Record<string, string>
): Promise<void> {
  const settings = await loadGlobalSettings();
  if (!settings.providers?.[providerName]) {
    throw new Error(`Provider '${providerName}' not configured. Run: spica set ${providerName} <url> <apiKey> <model>`);
  }
  settings.providers[providerName].models = models;
  await saveGlobalSettings(settings);
}

/** Change the default model for a provider */
export async function setDefaultModel(providerName: string, model: string): Promise<void> {
  const settings = await loadGlobalSettings();
  if (!settings.providers?.[providerName]) {
    throw new Error(`Provider '${providerName}' not configured`);
  }
  // If model is an alias, resolve it; otherwise use as-is
  const config = settings.providers[providerName];
  const resolved = config.models?.[model] || model;
  config.model = resolved;
  await saveGlobalSettings(settings);
}

export async function listProviders(): Promise<string[]> {
  const settings = await loadGlobalSettings();
  return Object.keys(settings.providers || {});
}

export async function setDefaultProvider(name: string): Promise<void> {
  const settings = await loadGlobalSettings();

  if (!settings.providers?.[name]) {
    throw new Error(`Provider '${name}' not configured`);
  }

  settings.defaultProvider = name;
  await saveGlobalSettings(settings);
}
