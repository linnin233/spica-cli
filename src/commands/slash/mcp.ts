import { COLORS } from '../../cli/ui/colors';
import { getMCPManager, generateExampleConfig } from '../../mcp/client';
import { loadGlobalSettings, saveGlobalSettings, GLOBAL_SETTINGS_FILE } from '../../utils/settings';
import type { SlashHandler } from './types';

export const mcpHandler: SlashHandler = async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const action = parts[0];
  const manager = getMCPManager();

  if (!action || action === 'status') {
    const connected = manager.listConnectedServers();
    const tools = manager.listAvailableTools();

    ctx.screen.appendScroll(COLORS.primary.bold('\nMCP Status:\n'));
    if (connected.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('\n  Run /mcp init to create example config\n'));
    } else {
      connected.forEach((s: string) => {
        ctx.screen.appendScroll(COLORS.muted(`  Connected: ${s}\n`));
      });
      ctx.screen.appendScroll(COLORS.muted(`  Tools: ${tools.length}\n`));
    }
    ctx.screen.appendScroll('\n');
    return;
  }

  if (action === 'init') {
    const currentSettings = await loadGlobalSettings();
    if ((currentSettings.mcp?.servers?.length ?? 0) > 0) {
      ctx.screen.appendScroll(COLORS.warning('\nMCP servers already configured\n'));
    } else {
      currentSettings.mcp = generateExampleConfig();
      await saveGlobalSettings(currentSettings);
      ctx.screen.appendScroll(
        COLORS.success(`\n[OK] MCP config added to ${GLOBAL_SETTINGS_FILE}\n`)
      );
    }
    return;
  }

  if (action === 'tools') {
    const allTools = manager.listAvailableTools();
    ctx.screen.appendScroll(COLORS.primary.bold('\nMCP Tools:\n'));
    if (allTools.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('  Connect a MCP server first\n'));
    } else {
      allTools.forEach((name: string) => {
        ctx.screen.appendScroll(
          `  ${COLORS.primary(name)}\n`,
        );
      });
    }
    ctx.screen.appendScroll('\n');
    return;
  }

  if (action === 'disconnect') {
    await manager.disconnectAll();
    ctx.screen.appendScroll(COLORS.success('\n[OK] All MCP servers disconnected\n'));
    return;
  }

  ctx.screen.appendScroll(COLORS.warning('\nUsage: /mcp [status|init|tools|disconnect]\n'));
};
