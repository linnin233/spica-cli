/**
 * GitHub REST API 客户端
 * 基于 fetch + GitHub REST API v3，不使用 Octokit 避免引入新依赖
 * Token 只在内存中，不落盘
 */

import { execa } from 'execa';

// —— 类型定义 ——

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: { login: string };
  comments: number;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

export interface PRResult {
  number: number;
  html_url: string;
}

export class GitHubClient {
  private token: string;
  private repo: string;       // "owner/repo" 格式
  private apiBase: string;

  constructor(token: string, repo: string) {
    this.token = token;
    this.repo = repo;
    this.apiBase = `https://api.github.com/repos/${repo}`;
  }

  // —— HTTP helper ——

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { accept?: string },
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;

    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      'User-Agent': 'spica-cli-auto-issue',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    if (options?.accept) {
      headers['Accept'] = options.accept;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `GitHub API ${method} ${path} 返回 ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // —— Issues ——

  /** 获取仓库的 issues（按 label 和时间过滤） */
  async listIssues(labels: string[], since?: string): Promise<GitHubIssue[]> {
    const params = new URLSearchParams({
      state: 'open',
      sort: 'created',
      direction: 'desc',
      per_page: '30',
    });

    if (labels.length > 0) {
      params.set('labels', labels.join(','));
    }

    if (since) {
      params.set('since', since);
    }

    const issues = await this.request<GitHubIssue[]>(
      'GET',
      `/issues?${params.toString()}`,
    );

    // GitHub /issues 端点会返回 PR（PR 也是 issue），过滤掉
    return issues.filter((i: any) => !i.pull_request);
  }

  /** 获取单个 issue 详情 */
  async getIssue(number: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>('GET', `/issues/${number}`);
  }

  /** 获取 issue 的所有评论 */
  async listComments(number: number): Promise<GitHubComment[]> {
    return this.request<GitHubComment[]>('GET', `/issues/${number}/comments`);
  }

  /** 在 issue 下留言 */
  async addComment(number: number, body: string): Promise<void> {
    await this.request('POST', `/issues/${number}/comments`, { body });
  }

  /** 给 issue 添加 label */
  async addLabel(number: number, label: string): Promise<void> {
    await this.request('POST', `/issues/${number}/labels`, { labels: [label] });
  }

  // —— 仓库信息 ——

  /** 获取仓库默认分支 */
  async getDefaultBranch(): Promise<string> {
    const repo = await this.request<{ default_branch: string }>('GET', '');
    return repo.default_branch;
  }

  /** 检查分支是否存在 */
  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.request('GET', `/git/refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  }

  // —— PR ——

  /** 创建 Pull Request */
  async createPR(
    title: string,
    head: string,
    base: string,
    body: string,
  ): Promise<PRResult> {
    return this.request<PRResult>('POST', '/pulls', {
      title,
      head,
      base,
      body,
    });
  }

  // —— Git 操作（通过 shell 执行） ——

  /** clone 仓库到本地（token 内联 URL，不落盘） */
  async cloneRepo(targetPath: string, branch?: string): Promise<void> {
    const cloneUrl = `https://x-access-token:${this.token}@github.com/${this.repo}.git`;

    const args = [
      '-c', 'credential.helper=',      // 禁止凭据管理器弹窗
      '-c', 'core.askPass=',
      'clone', '--depth', '1',
    ];
    if (branch) {
      args.push('-b', branch);
    }
    args.push(cloneUrl, targetPath);

    const result = await execa('git', args, {
      timeout: 120_000,
      reject: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },  // 禁止终端交互弹窗
    });

    if (result.exitCode !== 0) {
      throw new Error(`git clone 失败: ${result.stderr || result.stdout}`);
    }
  }

  /** commit 并 push 到远程分支 */
  async commitAndPush(
    repoPath: string,
    branch: string,
    message: string,
  ): Promise<void> {
    const pushUrl = `https://x-access-token:${this.token}@github.com/${this.repo}.git`;

    // git add all
    let result = await execa('git', ['add', '-A'], {
      cwd: repoPath,
      timeout: 30_000,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git add 失败: ${result.stderr || result.stdout}`);
    }

    // git commit
    result = await execa('git', ['commit', '-m', message, '--allow-empty'], {
      cwd: repoPath,
      timeout: 30_000,
      reject: false,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      // exitCode 1 = nothing to commit（允许）
      throw new Error(`git commit 失败: ${result.stderr || result.stdout}`);
    }

    // git push
    result = await execa('git', ['push', pushUrl, `${branch}:${branch}`], {
      cwd: repoPath,
      timeout: 60_000,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git push 失败: ${result.stderr || result.stdout}`);
    }
  }

  /** 创建并切换到新分支 */
  async createBranch(
    repoPath: string,
    branch: string,
    base?: string,
  ): Promise<void> {
    if (base) {
      // 确保在 base 分支上
      const result = await execa('git', ['checkout', base], {
        cwd: repoPath,
        timeout: 30_000,
        reject: false,
      });
      if (result.exitCode !== 0) {
        throw new Error(`git checkout ${base} 失败: ${result.stderr}`);
      }
    }

    const result = await execa('git', ['checkout', '-b', branch], {
      cwd: repoPath,
      timeout: 30_000,
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git checkout -b ${branch} 失败: ${result.stderr}`);
    }
  }
}
