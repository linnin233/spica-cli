import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ProcessMonitor, ProcessInfo, ProcessStatus } from '../ProcessMonitor';

const TEST_PROCESS_DIR = path.join(os.tmpdir(), 'spica-test-processes');
const isWindows = process.platform === 'win32';

function echoCmd(msg: string): { command: string; args: string[] } {
  return { command: 'node', args: ['-e', `console.log("${msg}")`] };
}

function sleepCmd(seconds: number): { command: string; args: string[] } {
  return { command: 'node', args: ['-e', `setTimeout(() => {}, ${seconds * 1000})`] };
}

describe('ProcessMonitor', () => {
  let monitor: ProcessMonitor;

  beforeEach(async () => {
    await fs.ensureDir(TEST_PROCESS_DIR);
    monitor = new ProcessMonitor(TEST_PROCESS_DIR);
  });

  afterEach(async () => {
    await monitor.killAll();
    await fs.remove(TEST_PROCESS_DIR);
  });

  describe('start', () => {
    it('starts a process and tracks it', async () => {
      const { command, args } = echoCmd('hello');
      const info = await monitor.start(command, args, 'test-process');

      expect(info.id).toBe('test-process');
      expect(info.pid).toBeDefined();
      expect(info.status).toBe(ProcessStatus.RUNNING);
    });

    it('assigns unique id if not provided', async () => {
      const { command, args } = echoCmd('test');
      const info = await monitor.start(command, args);

      expect(info.id).toBeDefined();
      expect(info.id.length).toBeGreaterThan(0);
    });

    it('throws if process fails to start', async () => {
      await expect(monitor.start('nonexistent-command-xyz', [])).rejects.toThrow();
    });
  });

  describe('monitor', () => {
    it('returns process info by id', async () => {
      const { command, args } = sleepCmd(1);
      const started = await monitor.start(command, args, 'sleepy');
      const info = await monitor.monitor('sleepy');

      expect(info).toBeDefined();
      expect(info?.pid).toBe(started.pid);
    });

    it('returns undefined for unknown process', async () => {
      const info = await monitor.monitor('unknown');
      expect(info).toBeUndefined();
    });

    it('detects when process exits', async () => {
      const { command, args } = echoCmd('quick');
      await monitor.start(command, args, 'quick-process');

      await new Promise(resolve => setTimeout(resolve, 200));

      const info = await monitor.monitor('quick-process');
      expect(info?.status).toBe(ProcessStatus.EXITED);
    });
  });

  describe('kill', () => {
    it('kills a running process', async () => {
      const { command, args } = sleepCmd(2);
      await monitor.start(command, args, 'long-sleep');

      await new Promise(resolve => setTimeout(resolve, 50));

      const killed = await monitor.kill('long-sleep');
      expect(killed).toBe(true);

      const info = await monitor.monitor('long-sleep');
      expect([ProcessStatus.KILLED, ProcessStatus.EXITED]).toContain(info?.status);
    });

    it('returns false for unknown process', async () => {
      const killed = await monitor.kill('unknown');
      expect(killed).toBe(false);
    });
  });

  describe('logs', () => {
    it('captures stdout', async () => {
      const { command, args } = echoCmd('output');
      await monitor.start(command, args, 'logger');

      await new Promise(resolve => setTimeout(resolve, 200));

      const logs = await monitor.getLogs('logger');
      expect(logs.stdout).toContain('output');
    });

    it('captures stderr', async () => {
      await monitor.start('node', ['-e', 'console.error("error output")'], 'stderr-test');

      await new Promise(resolve => setTimeout(resolve, 200));

      const logs = await monitor.getLogs('stderr-test');
      expect(logs.stderr).toContain('error output');
    });

    it('persists logs to file', async () => {
      const { command, args } = echoCmd('persisted');
      await monitor.start(command, args, 'persist-test');

      await new Promise(resolve => setTimeout(resolve, 200));

      const logPath = path.join(TEST_PROCESS_DIR, 'persist-test.log');
      const exists = await fs.pathExists(logPath);
      expect(exists).toBe(true);
    });
  });

  describe('list', () => {
    it('lists all tracked processes', async () => {
      const { command, args } = sleepCmd(1);
      await monitor.start(command, args, 'p1');
      await monitor.start(command, args, 'p2');

      const processes = await monitor.list();
      expect(processes).toHaveLength(2);
      expect(processes.map(p => p.id)).toContain('p1');
      expect(processes.map(p => p.id)).toContain('p2');
    });
  });

  describe('killAll', () => {
    it('kills all tracked processes', async () => {
      const { command, args } = sleepCmd(2);
      await monitor.start(command, args, 'kill1');
      await monitor.start(command, args, 'kill2');

      await monitor.killAll();

      const processes = await monitor.list();
      processes.forEach(p => {
        expect([ProcessStatus.KILLED, ProcessStatus.EXITED]).toContain(p.status);
      });
    });
  });
});
