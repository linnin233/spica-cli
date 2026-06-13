import { Command } from 'commander';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  getProviderConfig,
  setProviderConfig,
  setProviderModels,
  listProviders,
  setDefaultProvider,
  resolveModel,
  listProviderModels,
} from '../utils/settings';
import { COLORS } from '../cli/ui/colors';

/**
 * Register provider management commands (set, use, list, show, remove, models).
 */
export function registerProviderCommands(program: Command): void {
  program
    .command('set <name> <url> <apiKey> <model>')
    .description('Add or update a provider')
    .action(async (name, url, apiKey, model) => {
      await setProviderConfig(name, apiKey, url, model);
      console.log(COLORS.success(`[OK] ${name}`));
    });

  program
    .command('use <name>')
    .description('Switch default provider')
    .action(async name => {
      try {
        await setDefaultProvider(name);
        console.log(COLORS.success(`[OK] using ${name}`));
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });

  program
    .command('list')
    .description('List providers')
    .action(async () => {
      const providers = await listProviders();
      const defaultProvider = (await loadGlobalSettings()).defaultProvider;
      providers.forEach(p => {
        const mark = p === defaultProvider ? '*' : ' ';
        console.log(`${mark} ${p}`);
      });
    });

  program
    .command('show [name]')
    .description('Show provider config')
    .action(async name => {
      name = name || (await loadGlobalSettings()).defaultProvider;
      if (!name) return console.log('No default provider');
      try {
        const c = await getProviderConfig(name);
        console.log(`name:    ${c.name}`);
        console.log(`url:     ${c.baseUrl}`);
        console.log(`key:     ${c.apiKey.slice(0, 8)}...`);
        console.log(`model:   ${c.model}`);
        const models = listProviderModels(c);
        if (models) {
          console.log('models:');
          models.forEach(m => console.log(`  ${m}`));
        } else {
          console.log(`models:  (none configured — use "spica models set ${name} <alias> <model-id>")`);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });

  program
    .command('remove [names...]')
    .description('Remove providers (use --all to remove all)')
    .option('-a, --all', 'Remove all')
    .action(async (names, opts) => {
      const config = await loadGlobalSettings();
      if (opts.all) {
        const all = Object.keys(config.providers || {});
        config.providers = {};
        config.defaultProvider = undefined;
        await saveGlobalSettings(config);
        console.log(COLORS.success(`[OK] removed: ${all.join(', ')}`));
        return;
      }
      if (!names.length) return console.log('Usage: remove <names...> or --all');
      for (const n of names) {
        if (config.providers?.[n]) {
          delete config.providers[n];
          if (config.defaultProvider === n) config.defaultProvider = undefined;
          console.log(COLORS.success(`[OK] ${n}`));
        } else {
          console.log(COLORS.error(`[ERR] ${n} not found`));
        }
      }
      await saveGlobalSettings(config);
    });

  // Model alias management
  const modelsCmd = program
    .command('models')
    .description('Manage model aliases for a provider');

  modelsCmd
    .command('list [provider]')
    .description('List model aliases')
    .action(async provider => {
      provider = provider || (await loadGlobalSettings()).defaultProvider;
      if (!provider) return console.log('No default provider');
      try {
        const c = await getProviderConfig(provider);
        const models = listProviderModels(c);
        if (models) {
          console.log(`${provider} models:`);
          models.forEach(m => console.log(`  ${m}`));
          console.log(`\ndefault: ${c.model}`);
        } else {
          console.log(`No model aliases for ${provider}.`);
          console.log(`Default model: ${c.model}`);
          console.log(`\nAdd with: spica models set ${provider} <alias> <model-id>`);
          console.log(`Example: spica models set ${provider} mini gpt-4o-mini`);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });

  modelsCmd
    .command('set <provider> <alias> <modelId>')
    .description('Set a model alias (e.g., "mini" → "gpt-4o-mini")')
    .action(async (provider, alias, modelId) => {
      try {
        const c = await getProviderConfig(provider);
        const models = { ...(c.models || {}), [alias]: modelId };
        await setProviderModels(provider, models);
        console.log(COLORS.success(`[OK] ${provider}: ${alias} → ${modelId}`));
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });

  modelsCmd
    .command('remove <provider> <alias>')
    .description('Remove a model alias')
    .action(async (provider, alias) => {
      try {
        const c = await getProviderConfig(provider);
        if (!c.models || !c.models[alias]) {
          console.log(COLORS.error(`[ERR] alias '${alias}' not found for ${provider}`));
          return;
        }
        const models = { ...c.models };
        delete models[alias];
        await setProviderModels(provider, models);
        console.log(COLORS.success(`[OK] removed ${alias} from ${provider}`));
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });

  modelsCmd
    .command('resolve <provider> [alias]')
    .description('Resolve a model alias to its actual model ID')
    .action(async (provider, alias) => {
      try {
        const c = await getProviderConfig(provider);
        const resolved = resolveModel(c, alias);
        if (alias) {
          console.log(`${alias} → ${resolved}${resolved === c.model && !c.models?.[alias || ''] ? ' (default)' : ''}`);
        } else {
          console.log(`default: ${resolved}`);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });
}
