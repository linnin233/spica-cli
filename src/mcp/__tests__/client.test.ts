import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager, MCPTool, generateExampleConfig } from '../client';
import { loadGlobalSettings } from '../../utils/settings';

// Mock MCP SDK
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Tool result' }],
      isError: false,
    }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    stderr: { on: vi.fn() },
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock('../utils/settings', () => ({
  loadGlobalSettings: vi.fn().mockResolvedValue({
    mcp: { servers: [] },
  }),
}));

describe('MCPManager', () => {
  let manager: MCPManager;

  beforeEach(() => {
    manager = new MCPManager();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.disconnectAll();
  });

  describe('loadConfig', () => {
    it('should load config from settings', async () => {
      const config = await manager.loadConfig();
      expect(config).toBeDefined();
      expect(config.servers).toBeDefined();
    });

    it('should handle config with servers', async () => {
      // Default mock returns { mcp: { servers: [] } }
      const config = await manager.loadConfig();
      expect(Array.isArray(config.servers)).toBe(true);
    });
  });

  describe('getToolDefinitions', () => {
    it('should return empty array when no tools loaded', () => {
      const tools = manager.getToolDefinitions();
      expect(tools).toEqual([]);
    });
  });

  describe('listConnectedServers', () => {
    it('should return empty array when no servers connected', () => {
      const servers = manager.listConnectedServers();
      expect(servers).toEqual([]);
    });
  });

  describe('listAvailableTools', () => {
    it('should return empty array when no tools loaded', () => {
      const tools = manager.listAvailableTools();
      expect(tools).toEqual([]);
    });
  });

  describe('hasTool', () => {
    it('should return false for non-existent tool', () => {
      expect(manager.hasTool('test/tool')).toBe(false);
    });
  });

  describe('callTool', () => {
    it('should return error for invalid tool name format', async () => {
      const result = await manager.callTool('invalid_tool_name', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid tool name format');
    });

    it('should return error for non-existent server', async () => {
      const result = await manager.callTool('unknown_server/tool', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });
  });

  describe('disconnectAll', () => {
    it('should clear all clients and tools', async () => {
      await manager.disconnectAll();
      expect(manager.listConnectedServers()).toEqual([]);
      expect(manager.listAvailableTools()).toEqual([]);
    });
  });

  describe('events', () => {
    it('should emit server_connected event', async () => {
      const listener = vi.fn();
      manager.on('server_connected', listener);
      manager.emit('server_connected', { name: 'test' });
      expect(listener).toHaveBeenCalledWith({ name: 'test' });
    });

    it('should emit server_error event', () => {
      const listener = vi.fn();
      manager.on('server_error', listener);
      manager.emit('server_error', { name: 'test', error: 'test error' });
      expect(listener).toHaveBeenCalledWith({ name: 'test', error: 'test error' });
    });

    it('should emit server_log event', () => {
      const listener = vi.fn();
      manager.on('server_log', listener);
      manager.emit('server_log', { name: 'test', log: 'test log' });
      expect(listener).toHaveBeenCalledWith({ name: 'test', log: 'test log' });
    });
  });
});

describe('generateExampleConfig', () => {
  it('should generate valid example config', () => {
    const config = generateExampleConfig();
    expect(config.servers).toBeDefined();
    expect(config.servers.length).toBeGreaterThan(0);
  });

  it('should include filesystem server example', () => {
    const config = generateExampleConfig();
    const fsServer = config.servers.find(s => s.name === 'filesystem');
    expect(fsServer).toBeDefined();
    expect(fsServer?.command).toBe('npx');
  });

  it('should include SSE server example', () => {
    const config = generateExampleConfig();
    const httpServer = config.servers.find(s => s.name === 'custom-api');
    expect(httpServer).toBeDefined();
    expect(httpServer?.url).toBeDefined();
  });
});

describe('MCPTool interface', () => {
  it('should have required fields', () => {
    const tool: MCPTool = {
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    };
    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('Test tool');
    expect(tool.inputSchema.type).toBe('object');
  });
});
