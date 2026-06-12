// Provider 配置 - 已迁移到 settings.ts
// 此文件保留为兼容层，新代码应使用 settings.ts

import {
  loadGlobalSettings,
  saveGlobalSettings,
  ProviderConfig,
  getProviderConfig as settingsGetProviderConfig,
  setProviderConfig as settingsSetProviderConfig,
} from './settings';

// 导出类型
export type { ProviderConfig };

export interface Config {
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
}

// DEFAULT_MODELS（兼容层）
const DEFAULT_MODELS: Record<string, string> = {};
export { DEFAULT_MODELS };

// 兼容层函数
export async function loadConfig(): Promise<Config> {
  const settings = await loadGlobalSettings();
  return {
    defaultProvider: settings.defaultProvider,
    providers: settings.providers,
  };
}

export async function saveConfig(config: Config): Promise<void> {
  const settings = await loadGlobalSettings();
  settings.defaultProvider = config.defaultProvider;
  settings.providers = config.providers;
  await saveGlobalSettings(settings);
}

export async function getProviderConfig(providerName?: string): Promise<ProviderConfig> {
  return settingsGetProviderConfig(providerName);
}

export async function setProviderConfig(
  name: string,
  apiKey: string,
  baseUrl?: string,
  model?: string
): Promise<void> {
  return settingsSetProviderConfig(name, apiKey, baseUrl, model);
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

export async function setConfigValue(key: string, value: string): Promise<void> {
  const settings = await loadGlobalSettings();
  const parts = key.split('.');
  if (parts.length === 2) {
    const [provider, field] = parts;
    if (!settings.providers) settings.providers = {};
    if (!settings.providers[provider]) {
      settings.providers[provider] = {
        name: provider,
        apiKey: '',
        baseUrl: '',
        model: 'gpt-4o',
      };
    }
    if (field === 'apiKey') settings.providers[provider].apiKey = value;
    else if (field === 'model') settings.providers[provider].model = value;
    else if (field === 'baseUrl') settings.providers[provider].baseUrl = value;
    await saveGlobalSettings(settings);
  }
}

export async function getConfigValue(key: string): Promise<string | undefined> {
  const settings = await loadGlobalSettings();
  const parts = key.split('.');
  if (parts.length === 2) {
    const [provider, field] = parts;
    if (settings.providers?.[provider]) {
      if (field === 'apiKey') return settings.providers[provider].apiKey;
      if (field === 'model') return settings.providers[provider].model;
      if (field === 'baseUrl') return settings.providers[provider].baseUrl;
    }
  }
  return undefined;
}
