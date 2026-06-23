import { Command } from 'commander';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  getProviderConfig,
  setProviderConfig,
  setProviderModels,
  setDefaultModel,
  listProviders,
  setDefaultProvider,
  resolveModel,
  listProviderModels,
} from '../utils/settings';
import { COLORS } from '../cli/ui/colors';

/**
 * Register provider management commands.
 *
 * Provider = one API endpoint. Each provider has:
 *   model  — the default model (used when no model specified)
 *   models — alias→id map (e.g. {"fast": "v4-flash", "pro": "v4-pro"})
 */
export function registerProviderCommands(program: Command): void {
  // spica set <name> <url> <apiKey> [model] --models fast:id1,pro:id2
  program
    .command('set <name> <url> <apiKey> [model]')
    .description('Add or update a provider')
    .option('--models <list>', 'model aliases: alias1:id1,alias2:id2')
    .action(async (name, url, apiKey, model, opts) => {
      // Parse --models: "fast:v4-flash,pro:v4-pro" → { fast: "v4-flash", pro: "v4-pro" }
      let models: Record<string, string> | undefined;
      if (opts.models) {
        models = {};
        for (const pair of (opts.models as string).split(',')) {
          const [alias, ...idParts] = pair.split(':');
          const id = idParts.join(':').trim(); // handle model IDs with colons
          if (alias.trim() && id) {
            models[alias.trim()] = id;
          }
        }
        if (Object.keys(models).length === 0) models = undefined;
      }

      await setProviderConfig(name, apiKey, url, model, models);
      console.log(COLORS.success(`[OK] ${name}`));
      if (model) console.log(`  default model: ${model}`);
      if (models) {
        for (const [alias, id] of Object.entries(models)) {
          console.log(`  ${alias} → ${id}`);
        }
      }
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
        console.log(`name:     ${c.name}`);
        console.log(`url:      ${c.baseUrl}`);
        console.log(`key:      ${c.apiKey.slice(0, 8)}...`);
        console.log(`default:  ${c.model}`);

        const modelList = listProviderModels(c);
        if (modelList) {
          console.log('aliases:');
          for (const m of modelList) {
            const [alias, id] = m.split(' → ');
            const marker = id === c.model ? ' (default)' : '';
            console.log(`  ${alias} → ${id}${marker}`);
          }
        } else {
          console.log('aliases:  (none)');
        }
        console.log(`\nSet default:  spica models default ${c.name} <alias>`);
        console.log(`Add alias:    spica models set ${c.name} <alias> <model-id>`);
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

  // ── Model alias management ──

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
        console.log(`${provider}  default: ${c.model}`);
        const modelList = listProviderModels(c);
        if (modelList) {
          for (const m of modelList) {
            const [alias, id] = m.split(' → ');
            const marker = id === c.model ? ' (default)' : '';
            console.log(`  ${alias} → ${id}${marker}`);
          }
        } else {
          console.log('  (no aliases)');
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });

  modelsCmd
    .command('set <provider> <alias> <modelId>')
    .description('Add a model alias (e.g., "fast" → "deepseek-v4-flash")')
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
    .command('default <provider> <alias>')
    .description('Set the default model for a provider (by alias or model ID)')
    .action(async (provider, alias) => {
      try {
        await setDefaultModel(provider, alias);
        const c = await getProviderConfig(provider);
        console.log(COLORS.success(`[OK] ${provider} default model → ${c.model}`));
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
          const viaAlias = c.models?.[alias] ? ' (via alias)' : ' (direct)';
          console.log(`${alias} → ${resolved}${viaAlias}`);
        } else {
          console.log(`default: ${resolved}`);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.log(COLORS.error(errorMsg));
      }
    });
}
