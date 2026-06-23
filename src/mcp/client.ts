// MCP (Model Context Protocol) Client
// 连接外部工具服务器，动态获取工具

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { EventEmitter } from 'events';
import { MCPServerConfig, loadGlobalSettings } from '../utils/settings';

// MCPTool 定义（仅在本模块使用）
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPConfig {
  servers: MCPServerConfig[];
}

// MCPManager class
export class MCPManager extends EventEmitter {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, { serverName: string; tool: MCPTool }> = new Map();

  constructor() {
    super();
  }

  // 加载配置（从 settings.json）
  async loadConfig(): Promise<MCPConfig> {
    const settings = await loadGlobalSettings();
    return settings.mcp || { servers: [] };
  }

  // 连接所有配置的MCP服务器
  async connectAll(): Promise<void> {
    const config = await this.loadConfig();

    for (const server of config.servers) {
      if (server.disabled) continue;

      try {
        await this.connectServer(server);
        this.emit('server_connected', { name: server.name });
      } catch (error: any) {
        this.emit('server_error', { name: server.name, error: error.message });
      }
    }
  }

  // 连接单个服务器
  async connectServer(config: MCPServerConfig): Promise<void> {
    let transport: StdioClientTransport | SSEClientTransport;

    if (config.command) {
      // Stdio模式 - StdioClientTransport 会自动启动进程
      // 过滤敏感环境变量，防止 API keys 等泄露给 MCP 子进程
      const SENSITIVE_PATTERN = /api[_-]?key|token|secret|password|credential|auth/i;
      const safeEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (SENSITIVE_PATTERN.test(key) || SENSITIVE_PATTERN.test(value || '')) continue;
        safeEnv[key] = value as string;
      }

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...safeEnv, ...config.env } as Record<string, string>,
        stderr: 'pipe', // 捕获stderr
      });
    } else if (config.url) {
      // SSE模式 - HTTP连接，支持自定义 headers (OAuth token 等)
      const sseOptions: { requestInit?: { headers: Record<string, string> } } = {};
      if (config.headers) {
        sseOptions.requestInit = { headers: config.headers };
      }
      transport = new SSEClientTransport(new URL(config.url), sseOptions);
    } else {
      throw new Error(`MCP server ${config.name} needs either command or url`);
    }

    const client = new Client({ name: 'spica-mcp-client', version: '1.0.0' }, { capabilities: {} });

    await client.connect(transport);
    this.clients.set(config.name, client);

    // 监听stderr日志（通过transport.stderr获取，仅 Stdio 模式）
    if (transport instanceof StdioClientTransport) {
      const stdioTransport = transport as StdioClientTransport;
      if (
        (
          stdioTransport as unknown as {
            stderr?: { on?: (event: string, cb: (data: Buffer) => void) => void };
          }
        ).stderr
      ) {
        (
          stdioTransport as unknown as {
            stderr: { on: (event: string, cb: (data: Buffer) => void) => void };
          }
        ).stderr.on('data', (data: Buffer) => {
          this.emit('server_log', { name: config.name, log: data.toString() });
        });
      }
    }

    // 获取工具列表
    const toolsResult = await client.listTools();
    if (toolsResult.tools) {
      for (const tool of toolsResult.tools) {
        // 工具名加上服务器前缀避免冲突
        const fullName = `${config.name}/${tool.name}`;
        this.tools.set(fullName, {
          serverName: config.name,
          tool: {
            name: fullName,
            description: tool.description || '',
            inputSchema: tool.inputSchema as MCPTool['inputSchema'],
          },
        });
      }
    }
  }

  // 获取所有MCP工具定义
  getToolDefinitions(): MCPTool[] {
    return Array.from(this.tools.values()).map(t => t.tool);
  }

  // 调用MCP工具
  async callTool(
    fullName: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // 解析服务器名和工具名
    const [serverName, toolName] = fullName.split('/');
    if (!serverName || !toolName) {
      return { success: false, output: '', error: `Invalid tool name format: ${fullName}` };
    }

    const client = this.clients.get(serverName);
    if (!client) {
      return { success: false, output: '', error: `MCP server ${serverName} not connected` };
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      // 处理结果
      if (result.content) {
        const contentArray = result.content as unknown[];
        const textContent = contentArray
          .filter((c): c is { type: 'text'; text: string } => {
            if (c && typeof c === 'object' && c !== null && 'type' in c && 'text' in c) {
              const obj = c as { type: string; text: string };
              return obj.type === 'text';
            }
            return false;
          })
          .map(c => c.text)
          .join('\n');
        return { success: !result.isError, output: textContent };
      }

      return { success: true, output: 'Tool executed successfully' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: '', error: message };
    }
  }

  // 断开所有连接
  async disconnectAll(): Promise<void> {
    for (const [_name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // 忽略关闭错误
      }
    }
    this.clients.clear();
    this.tools.clear();

    // 关闭进程（StdioClientTransport会自动处理）
    // 清空客户端列表
    this.clients.clear();
    this.tools.clear();
  }

  // 列出已连接的服务器
  listConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  // 列出可用工具
  listAvailableTools(): string[] {
    return Array.from(this.tools.keys());
  }

  // 检查工具是否存在
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}

// 全局MCP管理器实例
let mcpManager: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  if (!mcpManager) {
    mcpManager = new MCPManager();
  }
  return mcpManager;
}

// 初始化MCP（在agent启动时调用）
export async function initMCP(): Promise<void> {
  const manager = getMCPManager();
  await manager.connectAll();
}

// 关闭MCP（在退出时调用）
export async function shutdownMCP(): Promise<void> {
  if (mcpManager) {
    await mcpManager.disconnectAll();
    mcpManager = null;
  }
}

// 示例配置生成
export function generateExampleConfig(): MCPConfig {
  return {
    servers: [
      // 文件系统服务器（stdio模式）
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-filesystem', '/home/user/project'],
      },
      // PostgreSQL服务器
      {
        name: 'postgres',
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-postgres'],
        env: {
          POSTGRES_URL: 'postgres://localhost/mydb',
        },
      },
      // HTTP服务器（SSE模式）
      {
        name: 'custom-api',
        url: 'http://localhost:3000/mcp',
      },
    ],
  };
}

// 保存示例配置到 settings.json
export async function saveExampleConfig(): Promise<void> {
  const settings = await loadGlobalSettings();
  settings.mcp = generateExampleConfig();
  const { saveGlobalSettings, GLOBAL_SETTINGS_FILE } = await import('../utils/settings');
  await saveGlobalSettings(settings);
  console.log(`MCP config saved to ${GLOBAL_SETTINGS_FILE}`);
}
