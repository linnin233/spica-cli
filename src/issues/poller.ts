/**
 * Issue 定时轮询器
 * EventEmitter 模式，定时拉取指定仓库的新 issues
 * 通过 IssueStateManager 去重，防止重复处理
 */

import { EventEmitter } from 'events';
import { GitHubClient, GitHubIssue } from './github';
import { IssueStateManager } from './state';

export interface PollerConfig {
  repos: string[];
  labels: string[];
  pollInterval: number;        // 秒
}

/**
 * 轮询器事件：
 * - new_issue: { repo, issue }  — 发现新 issue，交给 pipeline 处理
 * - poll_error: { repo, error } — 轮询出错
 * - poll_complete: { repo, count } — 轮询完成
 */
export class IssuePoller extends EventEmitter {
  private config: PollerConfig;
  private token: string;
  private state: IssueStateManager;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(token: string, config: PollerConfig, state: IssueStateManager) {
    super();
    this.token = token;
    this.config = config;
    this.state = state;
  }

  /** 启动对所有仓库的轮询 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.config.repos.forEach(repo => {
      this.scheduleRepo(repo);
    });

    console.log(
      `[IssuePoller] 开始轮询 ${this.config.repos.length} 个仓库，间隔 ${this.config.pollInterval}s`,
    );
  }

  /** 停止所有轮询 */
  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    console.log('[IssuePoller] 已停止');
  }

  /** 标记每个仓库是否已完成首次扫描 */
  private firstScanDone: Map<string, boolean> = new Map();

  /** 为单个仓库安排定时轮询 */
  private scheduleRepo(repo: string): void {
    this.firstScanDone.set(repo, false);

    const poll = async () => {
      try {
        await this.pollRepo(repo, !this.firstScanDone.get(repo));
      } catch (err) {
        this.emit('poll_error', {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 启动时立刻执行一次（首次扫描不传 since，获取所有历史 issues）
    poll();

    // 然后定时执行
    const timer = setInterval(poll, this.config.pollInterval * 1000);
    this.timers.set(repo, timer);
  }

  /** 对单个仓库执行一次轮询 */
  private async pollRepo(repo: string, isFirstScan = false): Promise<void> {
    const client = new GitHubClient(this.token, repo);

    // 首次扫描不传 since，获取所有未处理的 issues
    const since = isFirstScan ? undefined : this.state.getLastCheck(repo);

    let issues: GitHubIssue[];
    try {
      issues = await client.listIssues(this.config.labels, since);
    } catch (err) {
      this.emit('poll_error', {
        repo,
        error: `获取 issues 失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const newIssues: GitHubIssue[] = [];

    for (const issue of issues) {
      // 去重：跳过 state 中已处理或正在处理的
      if (
        this.state.isProcessed(repo, issue.number) ||
        this.state.isProcessing(repo, issue.number)
      ) {
        continue;
      }

      // 检查是否已有成功的 bot 评论（PR 已创建），跳过重复处理
      try {
        const comments = await client.listComments(issue.number);
        const hasSuccessComment = comments.some(c =>
          c.body.includes('spica-cli 已完成自动修复') ||
          c.body.includes('Pull Request:')
        );
        if (hasSuccessComment) {
          await this.state.markProcessed(repo, issue.number);
          continue;
        }
        // 如果有失败评论但没有成功评论，仍然重新处理
        const hasBotComment = comments.some(c =>
          c.body.includes('spica-cli')
        );
        if (hasBotComment) {
          console.log(`  [重新处理] #${issue.number} — 之前失败，重试`);
        }
      } catch {
        // 获取评论失败不影响主流程
      }

      newIssues.push(issue);
    }

    // 更新最后检查时间，首次扫描完成后标记
    await this.state.setLastCheck(repo, new Date().toISOString());
    if (isFirstScan) {
      this.firstScanDone.set(repo, true);
    }

    if (newIssues.length > 0) {
      console.log(`[IssuePoller] ${repo}: 发现 ${newIssues.length} 个新 issues`);
    }

    // 按创建时间排序（旧的先处理）
    newIssues.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    // 逐个 emit（pipeline 按序处理）
    for (const issue of newIssues) {
      this.emit('new_issue', { repo, issue });
    }

    this.emit('poll_complete', { repo, count: newIssues.length });
  }

  /** 一次性检查所有仓库（用于 spica issue once） */
  async checkOnce(): Promise<Array<{ repo: string; issue: GitHubIssue }>> {
    const allIssues: Array<{ repo: string; issue: GitHubIssue }> = [];

    for (const repo of this.config.repos) {
      const client = new GitHubClient(this.token, repo);
      try {
        const issues = await client.listIssues(this.config.labels);
        for (const issue of issues) {
          if (
            !this.state.isProcessed(repo, issue.number) &&
            !this.state.isProcessing(repo, issue.number)
          ) {
            allIssues.push({ repo, issue });
          }
        }
        await this.state.setLastCheck(repo, new Date().toISOString());
        await this.state.save();
      } catch (err) {
        this.emit('poll_error', {
          repo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return allIssues;
  }
}
