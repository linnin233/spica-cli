import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';

const isWindows = globalThis.process.platform === 'win32';

export enum ProcessStatus {
  RUNNING = 'running',
  EXITED = 'exited',
  KILLED = 'killed',
  FAILED = 'failed',
}

export interface ProcessInfo {
  id: string;
  pid?: number;
  command: string;
  args: string[];
  status: ProcessStatus;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
}

export interface ProcessLogs {
  stdout: string;
  stderr: string;
}

export class ProcessMonitor {
  private processDir: string;
  private processes: Map<string, { info: ProcessInfo; process?: ChildProcess }> = new Map();
  private logs: Map<string, ProcessLogs> = new Map();

  constructor(processDir: string) {
    this.processDir = processDir;
  }

  async start(command: string, args: string[], id?: string): Promise<ProcessInfo> {
    const processId = id || randomUUID();

    return new Promise((resolve, reject) => {
      const childProcess = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const info: ProcessInfo = {
        id: processId,
        pid: childProcess.pid,
        command,
        args,
        status: ProcessStatus.RUNNING,
        startTime: new Date(),
      };

      this.processes.set(processId, { info, process: childProcess });
      this.logs.set(processId, { stdout: '', stderr: '' });

      const logHandler = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
        const logs = this.logs.get(processId);
        if (logs) {
          logs[stream] += data.toString();
        }
      };

      childProcess.stdout?.on('data', logHandler('stdout'));
      childProcess.stderr?.on('data', logHandler('stderr'));

      childProcess.on('error', err => {
        const stored = this.processes.get(processId);
        if (stored) {
          stored.info.status = ProcessStatus.FAILED;
          stored.info.endTime = new Date();
        }
        this.persistLogs(processId);
        reject(err);
      });

      childProcess.on('spawn', () => {
        info.pid = childProcess.pid;
        resolve(info);
      });

      childProcess.on('close', code => {
        const stored = this.processes.get(processId);
        if (stored) {
          stored.info.status = ProcessStatus.EXITED;
          stored.info.endTime = new Date();
          stored.info.exitCode = code ?? 0;
        }
        this.persistLogs(processId);
        // Schedule cleanup: remove from memory after logs persisted
        setTimeout(() => this.cleanup(processId), 60000);
      });
    });
  }

  async monitor(id: string): Promise<ProcessInfo | undefined> {
    const stored = this.processes.get(id);
    return stored?.info;
  }

  async kill(id: string): Promise<boolean> {
    const stored = this.processes.get(id);
    if (!stored?.process) return false;

    return new Promise(resolve => {
      const process = stored.process!;

      process.on('close', () => {
        resolve(true);
      });

      stored.info.status = ProcessStatus.KILLED;
      stored.info.endTime = new Date();

      if (isWindows) {
        // Windows: SIGTERM 不支持，直接用 taskkill
        try {
          execSync(`taskkill /PID ${process.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // taskkill 失败时尝试 process.kill()
          try {
            process.kill();
          } catch {}
        }
      } else {
        // Unix: 先 SIGTERM，5秒后 SIGKILL 若进程仍在运行
        process.kill('SIGTERM');

        const sigkillTimer = setTimeout(() => {
          if (stored.info.status === ProcessStatus.KILLED) {
            // 进程未被 SIGTERM 终止，强制 SIGKILL
            try {
              process.kill('SIGKILL');
            } catch {
              /* 进程可能已退出 */
            }
          }
        }, 5000);

        // 若进程在 5 秒内退出，清除 SIGKILL 定时器
        process.once('close', () => clearTimeout(sigkillTimer));
      }
    });
  }

  async getLogs(id: string): Promise<ProcessLogs> {
    return this.logs.get(id) || { stdout: '', stderr: '' };
  }

  async list(): Promise<ProcessInfo[]> {
    return Array.from(this.processes.values()).map(p => p.info);
  }

  async killAll(): Promise<void> {
    const killPromises: Promise<boolean>[] = [];

    for (const [id, stored] of this.processes) {
      if (stored.info.status === ProcessStatus.RUNNING && stored.process) {
        killPromises.push(this.kill(id));
      }
    }

    await Promise.all(killPromises);
  }

  // 清理已退出/已终止的进程条目（释放内存）
  cleanup(id: string): void {
    const stored = this.processes.get(id);
    if (stored && stored.info.status !== ProcessStatus.RUNNING) {
      stored.process?.removeAllListeners();
      this.processes.delete(id);
      this.logs.delete(id);
    }
  }

  // 获取当前内存中追踪的进程数量
  get trackedCount(): number {
    return this.processes.size;
  }

  private async persistLogs(id: string): Promise<void> {
    const logs = this.logs.get(id);
    if (!logs) return;

    try {
      await fs.ensureDir(this.processDir);
      const logPath = path.join(this.processDir, `${id}.log`);
      const content = `STDOUT:\n${logs.stdout}\n\nSTDERR:\n${logs.stderr}`;
      await fs.writeFile(logPath, content);
    } catch {
      // ignore persistence errors
    }
  }
}
