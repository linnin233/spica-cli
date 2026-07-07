/**
 * Issue 处理状态持久化
 * 记录哪些 issues 已处理/处理中/失败，防止重复处理
 * 重启后恢复：stale processing 条目重新入队
 */

import fs from 'fs-extra';
import { join, dirname } from 'path';

// —— 类型 ——

interface ProcessingEntry {
  issue: number;
  startedAt: string;           // ISO timestamp
  phase: string;               // 当前阶段名
}

interface RepoState {
  lastCheck: string;
  processed: number[];
  processing: ProcessingEntry[];
  failed: Record<number, string>;  // issue编号 → 失败原因
}

interface IssueState {
  repos: Record<string, RepoState>;
}

// stale 超时：processing 超过此时间视为滞留，重新入队
const STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class IssueStateManager {
  private stateFile: string;
  private state: IssueState;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.state = { repos: {} };
  }

  /** 从磁盘加载状态（不存在则创建） */
  async load(): Promise<void> {
    try {
      await fs.ensureDir(dirname(this.stateFile));
      if (await fs.pathExists(this.stateFile)) {
        this.state = await fs.readJson(this.stateFile);
      }
    } catch {
      this.state = { repos: {} };
    }
  }

  /** 保存状态到磁盘 */
  async save(): Promise<void> {
    await fs.ensureDir(dirname(this.stateFile));
    await fs.writeJson(this.stateFile, this.state, { spaces: 2 });
  }

  /** 获取指定仓库的 RepoState（不存在则创建） */
  private getRepoState(repo: string): RepoState {
    if (!this.state.repos[repo]) {
      this.state.repos[repo] = {
        lastCheck: new Date(0).toISOString(),
        processed: [],
        processing: [],
        failed: {},
      };
    }
    return this.state.repos[repo];
  }

  /** 检查 issue 是否已处理 */
  isProcessed(repo: string, issueNum: number): boolean {
    const rs = this.getRepoState(repo);
    return rs.processed.includes(issueNum);
  }

  /** 检查 issue 是否正在处理中 */
  isProcessing(repo: string, issueNum: number): boolean {
    const rs = this.getRepoState(repo);
    return rs.processing.some(e => e.issue === issueNum);
  }

  /** 标记为处理中 */
  async markProcessing(repo: string, issueNum: number, phase: string): Promise<void> {
    const rs = this.getRepoState(repo);
    // 去重
    if (!rs.processing.some(e => e.issue === issueNum)) {
      rs.processing.push({
        issue: issueNum,
        startedAt: new Date().toISOString(),
        phase,
      });
    }
    await this.save();
  }

  /** 标记为已处理 */
  async markProcessed(repo: string, issueNum: number): Promise<void> {
    const rs = this.getRepoState(repo);
    // 从 processing 移除
    rs.processing = rs.processing.filter(e => e.issue !== issueNum);
    // 加入 processed
    if (!rs.processed.includes(issueNum)) {
      rs.processed.push(issueNum);
    }
    await this.save();
  }

  /** 标记为失败（记录原因，但不阻止重试） */
  async markFailed(repo: string, issueNum: number, reason: string): Promise<void> {
    const rs = this.getRepoState(repo);
    rs.processing = rs.processing.filter(e => e.issue !== issueNum);
    rs.failed[issueNum] = reason;
    // 不加入 processed，允许后续重试
    await this.save();
  }

  /** 更新 processing 阶段 */
  async updatePhase(repo: string, issueNum: number, phase: string): Promise<void> {
    const rs = this.getRepoState(repo);
    const entry = rs.processing.find(e => e.issue === issueNum);
    if (entry) {
      entry.phase = phase;
      await this.save();
    }
  }

  /** 更新最后检查时间 */
  async setLastCheck(repo: string, time: string): Promise<void> {
    this.getRepoState(repo).lastCheck = time;
    await this.save();
  }

  /** 获取最后检查时间 */
  getLastCheck(repo: string): string {
    return this.getRepoState(repo).lastCheck;
  }

  /**
   * 重启恢复：返回滞留超过 STALE_TIMEOUT 的 processing 条目
   * 这些 issue 需要重新入队处理
   */
  recoverStale(): Array<{ repo: string; issueNum: number }> {
    const now = Date.now();
    const stale: Array<{ repo: string; issueNum: number }> = [];

    for (const [repo, rs] of Object.entries(this.state.repos)) {
      const stillProcessing: ProcessingEntry[] = [];
      for (const entry of rs.processing) {
        const elapsed = now - new Date(entry.startedAt).getTime();
        if (elapsed > STALE_TIMEOUT_MS) {
          stale.push({ repo, issueNum: entry.issue });
        } else {
          stillProcessing.push(entry);
        }
      }
      rs.processing = stillProcessing;
    }

    return stale;
  }
}
