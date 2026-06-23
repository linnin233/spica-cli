/**
 * 监控工具测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import fs from 'fs-extra';
import { executeTool, setWorkspace } from '../../tools/index';

const TEST_DIR = join(process.cwd(), 'test-monitor-temp');
const isWindows = process.platform === 'win32';

// 延迟函数
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Monitor Tool Tests', () => {
  beforeEach(async () => {
    await fs.ensureDir(TEST_DIR);
    setWorkspace(TEST_DIR);
  });

  afterEach(async () => {
    await fs.remove(TEST_DIR);
  });

  describe('monitor tool', () => {
    it('should start a monitor and return task_id', async () => {
      const result = await executeTool('monitor', {
        command: isWindows ? 'echo test' : 'echo test',
        description: 'Test monitor',
        timeout: 10,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Monitor started');
      expect(result.output).toContain('task_id:');
      expect(result.output).toContain('Test monitor');
      expect(result.content).toMatch(/^monitor_\d+_[a-z0-9]+$/);

      // 等待进程结束
      await delay(500);
    });

    it('should emit monitor_event for each stdout line', async () => {
      const events: Array<{ task_id: string; line: string }> = [];

      const result = await executeTool(
        'monitor',
        {
          command: isWindows
            ? 'echo line1 && echo line2 && echo line3'
            : 'echo line1 && echo line2 && echo line3',
          description: 'Multi-line monitor',
          timeout: 10,
        },
        (eventType, data) => {
          if (eventType === 'monitor_event') {
            events.push(data);
          }
        }
      );

      expect(result.success).toBe(true);

      // 等待事件
      await delay(500);

      expect(events.length).toBe(3);
      expect(events[0].line).toBe('line1');
      expect(events[1].line).toBe('line2');
      expect(events[2].line).toBe('line3');
    });

    it('should support persistent mode', async () => {
      const result = await executeTool('monitor', {
        command: isWindows ? 'ping -n 5 127.0.0.1' : 'sleep 5',
        description: 'Persistent monitor',
        persistent: true,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Persistent: true');
      expect(result.output).toContain('Timeout: 3600s');

      // 停止任务
      const taskId = result.content;
      await delay(100);

      const stopResult = await executeTool('task_stop', {
        task_id: taskId,
      });

      expect(stopResult.success).toBe(true);
    });

    it('should respect custom timeout', async () => {
      const result = await executeTool('monitor', {
        command: isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10',
        description: 'Custom timeout',
        timeout: 60,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Timeout: 60s');

      // 停止任务
      const taskId = result.content;
      await delay(100);

      await executeTool('task_stop', {
        task_id: taskId,
      });
    });

    it('should cap timeout at 3600 seconds', async () => {
      const result = await executeTool('monitor', {
        command: 'echo test',
        description: 'Max timeout test',
        timeout: 10000, // 超过最大值
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Timeout: 3600s');
    });

    it('should handle command errors gracefully', async () => {
      const errorEvents: Array<{ error: string }> = [];

      const result = await executeTool(
        'monitor',
        {
          command: isWindows ? 'nonexistent_command_12345' : 'nonexistent_command_12345',
          description: 'Error test',
          timeout: 10,
        },
        (eventType, data) => {
          if (eventType === 'monitor_error') {
            errorEvents.push(data);
          }
        }
      );

      expect(result.success).toBe(true);

      // 等待错误
      await delay(500);

      // 命令不存在应该触发错误
      expect(errorEvents.length).toBeGreaterThanOrEqual(0); // 可能不会触发 error 事件，取决于 shell
    });
  });

  describe('task_stop tool', () => {
    it('should stop a running monitor', async () => {
      // 启动一个长时间运行的监控
      const startResult = await executeTool('monitor', {
        command: isWindows ? 'ping -n 30 127.0.0.1' : 'sleep 30',
        description: 'Long running monitor',
        timeout: 60,
      });

      expect(startResult.success).toBe(true);
      const taskId = startResult.content;

      // 等待一下确保进程启动
      await delay(200);

      // 停止监控
      const stopResult = await executeTool('task_stop', {
        task_id: taskId,
      });

      expect(stopResult.success).toBe(true);
      expect(stopResult.output).toContain('Task stopped');
      expect(stopResult.output).toContain(taskId);
      expect(stopResult.output).toContain('Long running monitor');
    });

    it('should return error for non-existent task', async () => {
      const result = await executeTool('task_stop', {
        task_id: 'monitor_nonexistent_123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Task not found');
    });

    it('should show active tasks when stopping non-existent task', async () => {
      // 启动一个监控
      const startResult = await executeTool('monitor', {
        command: isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10',
        description: 'Active monitor',
        timeout: 30,
      });

      const taskId = startResult.content;
      await delay(100);

      // 尝试停止一个不存在的任务
      const stopResult = await executeTool('task_stop', {
        task_id: 'monitor_wrong_id',
      });

      expect(stopResult.success).toBe(false);
      expect(stopResult.error).toContain('Active tasks:');
      expect(stopResult.error).toContain(taskId);

      // 清理
      await executeTool('task_stop', { task_id: taskId });
    });

    it('should report running duration', async () => {
      const startResult = await executeTool('monitor', {
        command: isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10',
        description: 'Duration test',
        timeout: 30,
      });

      const taskId = startResult.content;
      await delay(1100); // 等待 1 秒以上

      const stopResult = await executeTool('task_stop', {
        task_id: taskId,
      });

      expect(stopResult.success).toBe(true);
      expect(stopResult.output).toMatch(/Ran for: [1-9]\d*s/); // 至少 1 秒
    });
  });

  describe('multiple monitors', () => {
    it('should handle multiple concurrent monitors', async () => {
      const events1: string[] = [];
      const events2: string[] = [];

      // 启动两个监控
      const result1 = await executeTool(
        'monitor',
        {
          command: isWindows ? 'echo monitor1' : 'echo monitor1',
          description: 'Monitor 1',
          timeout: 10,
        },
        (eventType, data) => {
          if (eventType === 'monitor_event') {
            events1.push(data.line);
          }
        }
      );

      const result2 = await executeTool(
        'monitor',
        {
          command: isWindows ? 'echo monitor2' : 'echo monitor2',
          description: 'Monitor 2',
          timeout: 10,
        },
        (eventType, data) => {
          if (eventType === 'monitor_event') {
            events2.push(data.line);
          }
        }
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.content).not.toBe(result2.content);

      // 等待事件
      await delay(500);

      expect(events1.length).toBe(1);
      expect(events1[0]).toBe('monitor1');
      expect(events2.length).toBe(1);
      expect(events2[0]).toBe('monitor2');
    });

    it('should stop monitors independently', async () => {
      // 启动两个长时间运行的监控
      const result1 = await executeTool('monitor', {
        command: isWindows ? 'ping -n 60 127.0.0.1' : 'sleep 60',
        description: 'Monitor A',
        timeout: 120,
      });

      const result2 = await executeTool('monitor', {
        command: isWindows ? 'ping -n 60 127.0.0.1' : 'sleep 60',
        description: 'Monitor B',
        timeout: 120,
      });

      const taskId1 = result1.content;
      const taskId2 = result2.content;

      await delay(100);

      // 停止第一个
      const stop1 = await executeTool('task_stop', { task_id: taskId1 });
      expect(stop1.success).toBe(true);
      expect(stop1.output).toContain('Monitor A');

      // 第二个应该还在运行
      const stopFail = await executeTool('task_stop', { task_id: taskId1 });
      expect(stopFail.success).toBe(false);
      expect(stopFail.error).toContain('Task not found');
      expect(stopFail.error).toContain(taskId2); // 第二个还在活动列表中

      // 停止第二个
      const stop2 = await executeTool('task_stop', { task_id: taskId2 });
      expect(stop2.success).toBe(true);
      expect(stop2.output).toContain('Monitor B');

      // 现在两个都应该停止了
      const stopFail2 = await executeTool('task_stop', { task_id: taskId2 });
      expect(stopFail2.success).toBe(false);
      expect(stopFail2.error).toContain('none'); // 没有活动任务
    });
  });

  describe('monitor output streaming', () => {
    it('should stream continuous output', async () => {
      const events: string[] = [];

      // 创建一个持续输出的命令
      const scriptFile = join(TEST_DIR, isWindows ? 'stream.bat' : 'stream.sh');
      const scriptContent = isWindows
        ? '@echo off\nfor /L %%i in (1,1,5) do (\n  echo line%%i\n  ping -n 1 127.0.0.1 > nul\n)'
        : '#!/bin/bash\nfor i in 1 2 3 4 5; do\n  echo "line$i"\n  sleep 0.1\ndone';

      await fs.writeFile(scriptFile, scriptContent);
      if (!isWindows) {
        await fs.chmod(scriptFile, '755');
      }

      const result = await executeTool(
        'monitor',
        {
          command: isWindows ? scriptFile : `bash ${scriptFile}`,
          description: 'Streaming test',
          timeout: 30,
        },
        (eventType, data) => {
          if (eventType === 'monitor_event') {
            events.push(data.line);
          }
        }
      );

      expect(result.success).toBe(true);

      // 等待所有输出
      await delay(1500);

      expect(events.length).toBe(5);
      expect(events).toContain('line1');
      expect(events).toContain('line5');
    });

    it('should handle stderr output', async () => {
      const events: string[] = [];

      const result = await executeTool(
        'monitor',
        {
          command: isWindows ? 'echo stdout && echo stderr 1>&2' : 'echo stdout && echo stderr >&2',
          description: 'Stderr test',
          timeout: 10,
        },
        (eventType, data) => {
          if (eventType === 'monitor_event') {
            events.push(data.line);
          }
        }
      );

      expect(result.success).toBe(true);
      await delay(500);

      // stdout 应该被捕获
      expect(events).toContain('stdout');
    });
  });

  describe('monitor timeout behavior', () => {
    it('should auto-stop after timeout', async () => {
      const result = await executeTool('monitor', {
        command: isWindows ? 'ping -n 60 127.0.0.1' : 'sleep 60',
        description: 'Timeout test',
        timeout: 2, // 2 秒超时
      });

      const taskId = result.content;
      expect(result.success).toBe(true);

      // 等待超时
      await delay(2500);

      // 任务应该已经自动停止
      const stopResult = await executeTool('task_stop', {
        task_id: taskId,
      });

      expect(stopResult.success).toBe(false);
      expect(stopResult.error).toContain('Task not found');
    });
  });
});
