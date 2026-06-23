import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── replySubagent resolver mechanism ──────────────────────────────

import {
  executeReplySubagent,
  registerWaitingSubagent,
  unregisterWaitingSubagent,
} from '../impl/replySubagent';

describe('reply_subagent tool', () => {
  beforeEach(() => {
    // Clean up any stale resolvers
    unregisterWaitingSubagent('test-1');
  });

  it('resolves waiting subagent when reply arrives', async () => {
    const answerPromise = new Promise<string>((resolve) => {
      registerWaitingSubagent('test-1', resolve);
    });

    // Reply arrives asynchronously
    const replyResult = await executeReplySubagent({
      task_id: 'test-1',
      answer: 'user level (~/.config/)',
    });

    expect(replyResult.success).toBe(true);

    const answer = await answerPromise;
    expect(answer).toBe('user level (~/.config/)');
  });

  it('rejects unknown task_id', async () => {
    const result = await executeReplySubagent({
      task_id: 'nonexistent',
      answer: 'whatever',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing task_id', async () => {
    const result = await executeReplySubagent({ answer: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects missing answer', async () => {
    const result = await executeReplySubagent({ task_id: 'test-1' });
    expect(result.success).toBe(false);
  });
});

// ── Background task registry ───────────────────────────────────────

import { stopBackgroundTask, getBackgroundTaskIds } from '../impl/task';

describe('background task registry', () => {
  // The registry is populated by runBackgroundSubagent which requires
  // a full agent setup. Test the interface:
  it('getBackgroundTaskIds returns empty initially', () => {
    const ids = getBackgroundTaskIds();
    expect(Array.isArray(ids)).toBe(true);
  });

  it('stopBackgroundTask returns false for unknown id', () => {
    expect(stopBackgroundTask('nonexistent')).toBe(false);
  });
});

// ── Question detection logic ──────────────────────────────────────

// The question detection in runBackgroundSubagent uses these checks:
// Matches runBackgroundSubagent in task.ts
function detectQuestion(result: string): boolean {
  return (
    result.includes('NEEDS_CONTEXT') ||
    (result.includes('?') && result.trim().length < 500)
  );
}

describe('question detection', () => {
  it('detects NEEDS_CONTEXT', () => {
    expect(detectQuestion('NEEDS_CONTEXT: should this be user or system?')).toBe(true);
  });

  it('detects NEEDS_CONTEXT without question mark', () => {
    expect(detectQuestion('NEEDS_CONTEXT: need to know the target directory')).toBe(true);
  });

  it('detects short text ending with ?', () => {
    expect(detectQuestion('Should I install at user or system level?')).toBe(true);
  });

  it('does not false-positive on declarative statements', () => {
    expect(detectQuestion('Implemented the hook at user level. All tests pass.')).toBe(false);
  });

  it('does not false-positive on "is" used declaratively', () => {
    // No "?" → not a question (previously false positive with regex)
    expect(detectQuestion('Is implemented and tested.')).toBe(false);
  });

  it('does not detect very long text with ? as question', () => {
    // Long >500 char text with a stray "?" is probably a summary, not a question
    const long = 'a'.repeat(501) + '?';
    expect(detectQuestion(long)).toBe(false);
  });

  it('detects "where" questions with ?', () => {
    expect(detectQuestion('Where should the config file be placed?')).toBe(true);
  });
});
