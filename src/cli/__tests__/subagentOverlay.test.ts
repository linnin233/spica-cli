import { describe, it, expect, beforeEach } from 'vitest';
import {
  subAgentState,
  getSortedAgents,
  renderOverlay,
  nextSpinnerFrame,
  SUBAGENT_TYPE_ICONS,
} from '../subagentPanel';

describe('subAgentState', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('adds and retrieves agents', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'find auth',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 explore]',
      priority: 1,
    });
    expect(subAgentState.agents.size).toBe(1);
    expect(subAgentState.get('id-1')?.type).toBe('explore');
  });

  it('clears all agents', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'test',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1]',
      priority: 1,
    });
    subAgentState.clear();
    expect(subAgentState.agents.size).toBe(0);
  });
});

describe('getSortedAgents', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('sorts error before running before done', () => {
    subAgentState.add('d', {
      type: 'explore',
      description: 'd',
      status: 'done',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#3]',
      priority: 2,
    });
    subAgentState.add('e', {
      type: 'fix',
      description: 'e',
      status: 'error',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1]',
      priority: 0,
      error: 'fail',
    });
    subAgentState.add('r', {
      type: 'build',
      description: 'r',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#2]',
      priority: 1,
    });

    const sorted = getSortedAgents();
    expect(sorted[0].id).toBe('e'); // error first
    expect(sorted[1].id).toBe('r'); // running second
    expect(sorted[2].id).toBe('d'); // done last
  });
});

describe('SUBAGENT_TYPE_ICONS', () => {
  it('has icons for all four types', () => {
    expect(SUBAGENT_TYPE_ICONS.explore).toBeTruthy();
    expect(SUBAGENT_TYPE_ICONS.review).toBeTruthy();
    expect(SUBAGENT_TYPE_ICONS.fix).toBeTruthy();
    expect(SUBAGENT_TYPE_ICONS.build).toBeTruthy();
  });
});

describe('nextSpinnerFrame', () => {
  it('cycles through all 10 frames', () => {
    const frames = new Set<string>();
    for (let i = 0; i < 10; i++) frames.add(nextSpinnerFrame());
    expect(frames.size).toBe(10);
  });
});

describe('renderOverlay', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('returns empty array when no agents', () => {
    expect(renderOverlay()).toEqual([]);
  });

  it('returns 7 lines (top border + title + 4 content + bottom) when agents exist', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'test',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 explore]',
      priority: 1,
    });
    const lines = renderOverlay();
    // 1 top border + 1 title + 1 status + 1 tool/empty + 2 empty fill + 1 bottom = 7
    expect(lines.length).toBe(7);
  });

  it('shows done agent without spinner', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'test',
      status: 'done',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 explore]',
      priority: 2,
      summary: 'all good',
    });
    const lines = renderOverlay();
    const statusLine = lines[2]; // Skip top border and title
    expect(statusLine).toContain('✓');
  });

  it('shows error agent with error detail', () => {
    subAgentState.add('id-1', {
      type: 'fix',
      description: 'test',
      status: 'error',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 fix]',
      priority: 0,
      error: 'ENOENT: no such file',
    });
    const lines = renderOverlay();
    expect(lines.some(l => l.includes('ENOENT'))).toBe(true);
  });
});
