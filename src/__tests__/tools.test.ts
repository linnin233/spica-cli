import { describe, it, expect, beforeEach } from 'vitest';
import { executeTool, setWorkspace, getWorkspace, getAllToolDefinitions, TOOLS_DEFINITIONS } from '../tools/index';

// We'll test the tool definitions and basic functionality
// For actual file operations, we rely on integration tests

describe('Tools Definitions', () => {
  describe('getAllToolDefinitions', () => {
    it('should return all tool definitions', () => {
      const definitions = getAllToolDefinitions();
      expect(definitions.length).toBeGreaterThan(0);
      expect(definitions[0].name).toBeDefined();
      expect(definitions[0].description).toBeDefined();
      expect(definitions[0].parameters).toBeDefined();
    });

    it('should include core file tools', () => {
      const definitions = getAllToolDefinitions();
      const toolNames = definitions.map(d => d.name);
      
      expect(toolNames).toContain('file_read');
      expect(toolNames).toContain('file_write');
      expect(toolNames).toContain('file_edit');
      expect(toolNames).toContain('file_delete');
    });

    it('should include shell tools', () => {
      const definitions = getAllToolDefinitions();
      const toolNames = definitions.map(d => d.name);
      
      expect(toolNames).toContain('bash');
      expect(toolNames).toContain('git');
    });

    it('should include utility tools', () => {
      const definitions = getAllToolDefinitions();
      const toolNames = definitions.map(d => d.name);
      
      expect(toolNames).toContain('glob');
      expect(toolNames).toContain('grep');
      expect(toolNames).toContain('workspace');
    });

    it('should include lint and test tools', () => {
      const definitions = getAllToolDefinitions();
      const toolNames = definitions.map(d => d.name);
      
      expect(toolNames).toContain('lint');
      expect(toolNames).toContain('test');
    });
  });

  describe('TOOLS_DEFINITIONS', () => {
    it('should be exported and accessible', () => {
      expect(TOOLS_DEFINITIONS).toBeDefined();
      expect(Array.isArray(TOOLS_DEFINITIONS)).toBe(true);
    });

    it('should have valid structure for each tool', () => {
      for (const def of TOOLS_DEFINITIONS) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.parameters.type).toBe('object');
        expect(def.parameters.properties).toBeDefined();
      }
    });
  });
});

describe('Workspace Management', () => {
  beforeEach(() => {
    setWorkspace('/test/workspace');
  });

  it('should set and get workspace', () => {
    setWorkspace('/new/workspace');
    expect(getWorkspace()).toBe('/new/workspace');
  });

  it('should return current workspace', () => {
    expect(getWorkspace()).toBe('/test/workspace');
  });
});

describe('Tool Result Structure', () => {
  it('should return error for unknown tool', async () => {
    const result = await executeTool('unknown_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('should have success field in result', async () => {
    const result = await executeTool('unknown_tool', {});
    expect(typeof result.success).toBe('boolean');
  });

  it('should have error field when failed', async () => {
    const result = await executeTool('unknown_tool', {});
    expect(result.error).toBeDefined();
  });
});

describe('Tool Descriptions', () => {
  it('should mention syntax check for file_write', () => {
    const writeTool = TOOLS_DEFINITIONS.find(t => t.name === 'file_write');
    expect(writeTool?.description).toContain('syntax');
  });

  it('should mention syntax check for file_edit', () => {
    const editTool = TOOLS_DEFINITIONS.find(t => t.name === 'file_edit');
    expect(editTool?.description).toContain('syntax');
  });

  it('should mention syntax check for file_multi_edit', () => {
    const multiEditTool = TOOLS_DEFINITIONS.find(t => t.name === 'file_multi_edit');
    expect(multiEditTool?.description).toContain('syntax');
  });

  it('should mention auto-detect for lint tool', () => {
    const lintTool = TOOLS_DEFINITIONS.find(t => t.name === 'lint');
    expect(lintTool?.description).toContain('Auto-detects');
  });

  it('should mention auto-detect for test tool', () => {
    const testTool = TOOLS_DEFINITIONS.find(t => t.name === 'test');
    expect(testTool?.description).toContain('Auto-detects');
  });
});

describe('Tool Parameters', () => {
  it('should have required path for file_read', () => {
    const readTool = TOOLS_DEFINITIONS.find(t => t.name === 'file_read');
    expect(readTool?.parameters.required).toContain('path');
  });

  it('should have required path and content for file_write', () => {
    const writeTool = TOOLS_DEFINITIONS.find(t => t.name === 'file_write');
    expect(writeTool?.parameters.required).toContain('path');
    expect(writeTool?.parameters.required).toContain('content');
  });

  it('should have required parameters for file_edit', () => {
    const editTool = TOOLS_DEFINITIONS.find(t => t.name === 'file_edit');
    expect(editTool?.parameters.required).toContain('path');
    expect(editTool?.parameters.required).toContain('oldString');
    expect(editTool?.parameters.required).toContain('newString');
  });

  it('should have optional parameters for bash', () => {
    const bashTool = TOOLS_DEFINITIONS.find(t => t.name === 'bash');
    expect(bashTool?.parameters.required).toContain('command');
  });
});