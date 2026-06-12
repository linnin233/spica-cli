import { Command } from 'commander';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  getProviderConfig,
  setProviderConfig,
  listProviders,
  setDefaultProvider,
} from '../utils/settings';
import { COLORS } from '../cli/ui/colors';

/**
 * Register provider management commands (set, use, list, show, remove).
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
        console.log(`name:   ${c.name}`);
        console.log(`url:    ${c.baseUrl}`);
        console.log(`key:    ${c.apiKey.slice(0, 8)}...`);
        console.log(`model:  ${c.model}`);
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
}
