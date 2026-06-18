import { describe, it, expect, vi } from 'vitest';
import { dispatchSlash } from '../index';
import type { SlashContext } from '../types';

function makeCtx(): SlashContext {
  const lines: string[] = [];
  return {
    agent: {
      getMessages: () => [],
      getContextMessages: () => [],
      getWorkspacePath: () => process.cwd(),
      setMessages: () => {},
      compact: async () => {},
      runLoop: async () => 'done',
      setQueueInputCallback: () => {},
      getProgressSnapshot: () => undefined,
      on: () => {},
      getLLM: () => null,
    } as any,
    screen: {
      appendScroll(text: string) {
        lines.push(text);
      },
      restoreCursor() {},
      clearThinkingAnimation() {},
      setStreaming() {},
      refreshInput() {},
      _lines: lines,
    } as any,
    state: {
      getCurrentBranch: () => null,
      setCurrentBranch: () => {},
      getAgent: () => null,
      getProviderConfig: () => ({}),
      getDisplayMode: () => 'compact',
      isProcessing: () => false,
      setProcessing: () => {},
      isStreamingOutput: () => false,
      setStreamingOutput: () => {},
      isInterrupted: () => false,
      setInterrupted: () => {},
      cycleDisplayMode: () => 'compact',
    } as any,
    tokenCounter: { estimateMessages: () => 0, getContextWindow: () => 128000 } as any,
    isProcessing: false,
    setProcessing: () => {},
    providerConfig: { model: 'test-model' },
    updateStatusBar: () => {},
    handleInput: async () => {},
  };
}

function getOutput(ctx: SlashContext): string {
  return (ctx.screen as any)._lines.join('');
}

describe('dispatchSlash', () => {
  it('/help should call helpHandler and produce output', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/help', ctx);
    expect(result).toBe(true);
    const output = getOutput(ctx);
    expect(output).toContain('Commands');
    expect(output).toContain('/help');
  });

  it('/h should call helpHandler (not sessionHandler)', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/h', ctx);
    expect(result).toBe(true);
    const output = getOutput(ctx);
    // Should contain help text, NOT session list
    expect(output).toContain('Commands');
    expect(output).toContain('/help');
  });

  it('/sum should be an alias for /summary', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/sum', ctx);
    expect(result).toBe(true);
    // Should produce some output (even if empty, it shouldn't crash)
  });

  it('/status should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/status', ctx);
    expect(result).toBe(true);
  });

  it('/queue should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/queue', ctx);
    expect(result).toBe(true);
  });

  it('/q should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/q', ctx);
    expect(result).toBe(true);
  });

  it('/history should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/history', ctx);
    expect(result).toBe(true);
  });

  it('/sessions should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/sessions', ctx);
    expect(result).toBe(true);
  });

  it('/compact should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/compact', ctx);
    expect(result).toBe(true);
  });

  it('/mcp should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/mcp', ctx);
    expect(result).toBe(true);
  });

  it('/skill should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/skill', ctx);
    expect(result).toBe(true);
  });

  it('/undo should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/undo', ctx);
    expect(result).toBe(true);
  });

  it('/archive should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/archive', ctx);
    expect(result).toBe(true);
  });

  it('/clear should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/clear', ctx);
    expect(result).toBe(true);
  });

  it('/reset should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/reset', ctx);
    expect(result).toBe(true);
  });

  it('/new should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/new', ctx);
    expect(result).toBe(true);
  });

  it('/view should work', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/view', ctx);
    expect(result).toBe(true);
  });

  it('/rename should produce output', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/rename', ctx);
    expect(result).toBe(true);
  });

  it('/delete should produce output', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/delete', ctx);
    expect(result).toBe(true);
  });

  it('/init should call handleInput with the init prompt', async () => {
    let calledWith = '';
    const ctx = makeCtx();
    ctx.handleInput = async (line: string) => { calledWith = line; };
    const result = await dispatchSlash('/init', ctx);
    expect(result).toBe(true);
    expect(calledWith).toContain('AGENTS.md');
  });

  it('unknown command should return false', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/nonexistent_command_xyz', ctx);
    expect(result).toBe(false);
  });

  it('unknown skill should return false (not silently swallow)', async () => {
    const ctx = makeCtx();
    const result = await dispatchSlash('/no_such_skill_xyz', ctx);
    expect(result).toBe(false);
  });
});
