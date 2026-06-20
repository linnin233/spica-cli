import { describe, it, expect, beforeEach } from 'vitest';
import {
  subAgentState,
  getSortedAgents,
  getRunningCount,
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

describe('getRunningCount', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('returns 0 when no agents', () => {
    expect(getRunningCount()).toBe(0);
  });

  it('returns count of running agents only', () => {
    subAgentState.add('r1', {
      type: 'explore',
      description: 'test',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1]',
      priority: 1,
    });
    subAgentState.add('r2', {
      type: 'fix',
      description: 'test',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#2]',
      priority: 1,
    });
    subAgentState.add('d1', {
      type: 'build',
      description: 'test',
      status: 'done',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#3]',
      priority: 2,
    });
    subAgentState.add('e1', {
      type: 'review',
      description: 'test',
      status: 'error',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#4]',
      priority: 0,
      error: 'fail',
    });
    expect(getRunningCount()).toBe(2);
  });
});
