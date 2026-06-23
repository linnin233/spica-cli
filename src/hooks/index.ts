// Hooks系统 - 拦截工具调用

import fs from 'fs-extra';
import { join } from 'path';
import {
  GLOBAL_DIR,
  HookDefinition,
  HookMatcher,
  HookResult,
  loadProjectHooks,
} from '../utils/settings';

// 导出类型（从 settings 导出）
export type { HookMatcher, HookDefinition, HookResult };

export interface HooksConfig {
  hooks: {
    PreToolUse?: HookDefinition[];
    PostToolUse?: HookDefinition[];
  };
}

// 加载 hooks 配置（全局 + 项目追加）
export function loadHooks(workspacePath?: string): HooksConfig {
  const ws = workspacePath || process.cwd();

  // 加载全局 hooks
  const globalSettings = loadGlobalSettingsSync();
  let hooks = globalSettings.hooks || { PreToolUse: [], PostToolUse: [] };

  // 加载项目 hooks（追加，但不能比全局 hooks 更宽松）
  const projectHooks = loadProjectHooks(ws);
  if (projectHooks) {
    // 构建全局 PreToolUse actions 映射（key: tool pattern）
    const globalPreActions = new Map<string, string>();
    for (const hook of hooks.PreToolUse || []) {
      const key = hook.matcher.tool || '*';
      globalPreActions.set(key, hook.action);
    }

    // 严格程度排序：none < warn < confirm < block
    const strictnessOrder: Record<string, number> = {
      none: 0,
      warn: 1,
      confirm: 2,
      block: 3,
    };

    // 过滤项目 PreToolUse hooks：不能比全局更宽松
    const filteredProjectPre = (projectHooks.PreToolUse || []).filter(hook => {
      const key = hook.matcher.tool || '*';
      const globalAction = globalPreActions.get(key);
      if (!globalAction) return true; // 全局未定义此工具，允许项目 hook

      const globalStrictness = strictnessOrder[globalAction] || 0;
      const projectStrictness = strictnessOrder[hook.action] || 0;

      // 项目 hooks 只能与全局同等或更严格，不能更宽松
      return projectStrictness >= globalStrictness;
    });

    hooks = {
      PreToolUse: [...(hooks.PreToolUse || []), ...filteredProjectPre],
      PostToolUse: [...(hooks.PostToolUse || []), ...(projectHooks.PostToolUse || [])],
    };
  }

  return { hooks };
}

// 同步加载全局 settings
function loadGlobalSettingsSync(): {
  hooks?: { PreToolUse?: HookDefinition[]; PostToolUse?: HookDefinition[] };
} {
  const globalPath = join(GLOBAL_DIR, 'settings.json');
  if (fs.existsSync(globalPath)) {
    try {
      return fs.readJsonSync(globalPath);
    } catch {
      return {};
    }
  }
  return {};
}

// 检查匹配
function matchesMatcher(
  toolName: string,
  args: Record<string, unknown>,
  matcher: HookMatcher
): boolean {
  // 检查工具名匹配
  if (matcher.tool) {
    const toolPattern = matcher.tool || '';
    if (toolPattern.includes('*')) {
      const pattern = toolPattern.replace('*', '');
      if (!toolName.includes(pattern)) return false;
    } else {
      if (toolName !== toolPattern) return false;
    }
  }

  // 检查参数匹配
  if (matcher.args) {
    for (const [key, pattern] of Object.entries(matcher.args)) {
      const value = String(args[key] || '');
      const patternStr = String(pattern || '');
      if (patternStr.includes('*')) {
        const prefix = patternStr.replace('*', '');
        if (!value.includes(prefix)) return false;
      } else {
        if (value !== patternStr) return false;
      }
    }
  }

  return true;
}

// 执行PreToolUse hooks
export function runPreHooks(toolName: string, args: Record<string, unknown>): HookResult {
  const safeArgs = args || {}; // 保护 args 参数
  const hooks = loadHooks();
  const preHooks = hooks.hooks.PreToolUse || [];

  for (const hook of preHooks) {
    if (matchesMatcher(toolName, safeArgs, hook.matcher)) {
      return {
        matched: true,
        action: hook.action,
        message: hook.message,
      };
    }
  }

  return { matched: false, action: 'none', message: '' };
}

// 执行PostToolUse hooks（返回日志消息）
export function runPostHooks(
  toolName: string,
  args: Record<string, unknown>,
  _result: unknown
): string | null {
  const safeArgs = args || {}; // 保护 args 参数
  const hooks = loadHooks();
  const postHooks = hooks.hooks.PostToolUse || [];

  for (const hook of postHooks) {
    if (matchesMatcher(toolName, safeArgs, hook.matcher)) {
      return hook.message;
    }
  }

  return null;
}
