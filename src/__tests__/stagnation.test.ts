import { describe, it, expect, beforeEach } from 'vitest';
import { SpicaAgent } from '../agent';

function getCheckStagnation(
  agent: SpicaAgent
): (hadProgress: boolean) => 'continue' | 'warn' | 'stop' {
  return (agent as any).checkStagnation.bind(agent);
}

describe('stagnation detection', () => {
  let agent: SpicaAgent;
  let checkStagnation: (hadProgress: boolean) => 'continue' | 'warn' | 'stop';

  beforeEach(() => {
    agent = new SpicaAgent('openai', '/test/workspace');
    checkStagnation = getCheckStagnation(agent);
  });

  it('returns continue on first no-progress round', () => {
    expect(checkStagnation(false)).toBe('continue');
  });

  it('returns continue after 7 rounds of no progress', () => {
    for (let i = 0; i < 7; i++) {
      expect(checkStagnation(false)).toBe('continue');
    }
  });

  it('returns warn at 8th round of no progress', () => {
    for (let i = 0; i < 7; i++) checkStagnation(false);
    expect(checkStagnation(false)).toBe('warn');
  });

  it('warns only once — subsequent rounds return continue', () => {
    for (let i = 0; i < 7; i++) checkStagnation(false);
    expect(checkStagnation(false)).toBe('warn'); // 8th
    expect(checkStagnation(false)).toBe('continue'); // 9th
  });

  it('returns stop at 16th round of no progress', () => {
    for (let i = 0; i < 15; i++) checkStagnation(false);
    expect(checkStagnation(false)).toBe('stop');
  });

  it('progress resets counter to zero', () => {
    for (let i = 0; i < 10; i++) checkStagnation(false);
    expect(checkStagnation(true)).toBe('continue');
    // Fresh start after progress
    expect(checkStagnation(false)).toBe('continue');
  });

  it('stays at continue when progress is made every round', () => {
    for (let i = 0; i < 30; i++) {
      expect(checkStagnation(true)).toBe('continue');
    }
  });
});
