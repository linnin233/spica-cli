import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ProcessMonitor, ProcessStatus } from '../../core/ProcessMonitor';

const TEST_PROCESS_DIR = path.join(os.tmpdir(), 'spica-test-cleanup');

describe('ProcessMonitor cleanup', () => {
  let monitor: ProcessMonitor;

  beforeEach(async () => {
    await fs.ensureDir(TEST_PROCESS_DIR);
    monitor = new ProcessMonitor(TEST_PROCESS_DIR);
  });

  afterEach(async () => {
    await monitor.killAll();
    await fs.remove(TEST_PROCESS_DIR);
  });

  it('cleanup removes exited process from memory', async () => {
    await monitor.start('node', ['-e', 'console.log("done")'], 'exit-test');

    // Wait for process to exit
    await new Promise(resolve => setTimeout(resolve, 300));

    const info = await monitor.monitor('exit-test');
    expect(info?.status).toBe(ProcessStatus.EXITED);

    // Manual cleanup should remove it
    monitor.cleanup('exit-test');

    const after = await monitor.monitor('exit-test');
    expect(after).toBeUndefined();
    expect(monitor.trackedCount).toBe(0);
  });

  it('cleanup does not remove running process', async () => {
    await monitor.start('node', ['-e', 'setTimeout(() => {}, 5000)'], 'running-test');

    monitor.cleanup('running-test');

    // Running process should still be tracked
    const info = await monitor.monitor('running-test');
    expect(info).toBeDefined();
    expect(monitor.trackedCount).toBe(1);

    await monitor.kill('running-test');
  });

  it('cleanup for unknown id does nothing', async () => {
    expect(() => monitor.cleanup('nonexistent')).not.toThrow();
  });
});
