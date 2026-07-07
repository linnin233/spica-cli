/**
 * Bug 修复流水线
 * 5 阶段串联：Understand → Reproduce → Fix → Verify → Submit PR
 * 每阶段硬性门禁，失败即退出并留言 + 邮件
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import fs from 'fs-extra';

import { GitHubClient, GitHubIssue, GitHubComment } from './github';
import { Notifier } from './notify';
import { IssueStateManager } from './state';
import { SpicaAgent } from '../agent';

import {
  buildUnderstandPrompt,
  buildReproducePrompt,
  buildFixPrompt,
  buildVerifyPrompt,
  buildStartComment,
  buildSuccessComment,
  buildFailComment,
  buildCannotReproduceComment,
  buildPRBody,
} from './prompts';

// —— 类型 ——

export interface PipelineResult {
  success: boolean;
  phase: string;
  issueNumber: number;
  prUrl?: string;
  error?: string;
  log: string[];
}

export interface PipelineContext {
  repo: string;
  issue: GitHubIssue;
  client: GitHubClient;
  notifier: Notifier | null;
  state: IssueStateManager;
  providerName: string;
  workDir: string;             // 临时工作目录
  log: string[];
}

// Pipeline 内部错误（用于阶段间控制流）
class PipelineError extends Error {
  phase: string;
  constructor(phase: string, message: string) {
    super(message);
    this.phase = phase;
    this.name = 'PipelineError';
  }
}

// —— Pipeline ——

export class BugPipeline {
  private providerName: string;
  private logFn: ((msg: string) => void) | null = null;

  constructor(providerName?: string, logFn?: (msg: string) => void) {
    this.providerName = providerName || 'default';
    this.logFn = logFn || null;
  }

  private log(msg: string) {
    if (this.logFn) this.logFn(msg);
  }

  /**
   * 执行完整流水线
   * @param client GitHubClient 实例
   * @param repo repo 名称 "owner/repo"
   * @param issue GitHub issue
   * @param notifier 邮件通知器（可选）
   * @param state 状态管理器
   */
  async execute(
    client: GitHubClient,
    repo: string,
    issue: GitHubIssue,
    notifier: Notifier | null,
    state: IssueStateManager,
  ): Promise<PipelineResult> {
    // 创建临时工作目录
    const workDir = join(tmpdir(), `spica-issue-${issue.number}-${randomUUID().slice(0, 8)}`);
    await fs.ensureDir(workDir);

    const ctx: PipelineContext = {
      repo,
      issue,
      client,
      notifier,
      state,
      providerName: this.providerName,
      workDir,
      log: [],
    };

    ctx.log.push(`开始处理 issue #${issue.number}: ${issue.title}`);

    try {
      // 留言：开始处理
      this.log(`[Phase 0/5] 标记处理中 + 留言`);
      await state.markProcessing(repo, issue.number, 'start');
      await client.addComment(issue.number, buildStartComment());

      // Clone 仓库到临时工作目录
      this.log(`[Phase 0/5] Clone 仓库...`);
      await state.updatePhase(repo, issue.number, 'clone');
      try {
        await client.cloneRepo(ctx.workDir);
        // 配置 git 身份（后续 commit 需要）
        const { execa } = await import('execa');
        await execa('git', ['config', 'user.email', 'spica-bot@linnin.cn'], { cwd: ctx.workDir });
        await execa('git', ['config', 'user.name', 'spica-cli[bot]'], { cwd: ctx.workDir });
        ctx.log.push('仓库 clone 完成');
      } catch (err) {
        return await this.handleFail(ctx, 'clone',
          `Clone 仓库失败: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 创建 agent 并复用
      this.log(`[Phase 1/5] Understand — 分析 issue 内容...`);
      const result = await this.withAgent(ctx, async (agent) => {
        // —— Phase 1: Understand ——
        await state.updatePhase(repo, issue.number, 'understand');
        const analysis = await this.phaseUnderstand(agent, ctx);
        if (!analysis) {
          throw new PipelineError('understand', 'AI 无法理解 issue 内容');
        }
        this.log(`[Phase 1/5] Understand 完成 — 严重程度: ${analysis.severity}`);

        // —— Phase 2: Reproduce ——
        this.log(`[Phase 2/5] Reproduce — 尝试复现 bug...`);
        await state.updatePhase(repo, issue.number, 'reproduce');
        const repro = await this.phaseReproduce(agent, ctx, analysis);
        if (repro.status === 'CANNOT') {
          await client.addComment(issue.number, buildCannotReproduceComment(repro.detail));
          ctx.log.push('Phase 2 Reproduce: CANNOT');
          await notifier?.notify({
            type: 'fix_blocked', repo,
            issue: { number: issue.number, title: issue.title, html_url: issue.html_url },
            error: repro.detail,
          });
          await state.markFailed(repo, issue.number, `CANNOT reproduce: ${repro.detail}`);
          throw new PipelineError('reproduce', '无法复现');
        }
        this.log(`[Phase 2/5] Reproduce — ${repro.status}`);

        // —— Phase 3: Fix ——
        this.log(`[Phase 3/5] Fix — AI 修复中...`);
        await state.updatePhase(repo, issue.number, 'fix');
        const fixResult = await this.phaseFix(agent, ctx, analysis, repro.evidence);
        if (!fixResult.ok) {
          throw new PipelineError('fix', fixResult.error || '修复失败');
        }

        // 确认 agent 实际修改了文件（git diff 检查）
        const { execa: ex } = await import('execa');
        const diffResult = await ex('git', ['diff', '--stat'], {
          cwd: ctx.workDir, timeout: 10_000, reject: false,
        });
        if (!diffResult.stdout.trim()) {
          ctx.log.push('Phase 3 Fix: 没有检测到文件变更！agent 声称修复但未实际修改代码');
          throw new PipelineError('fix', 'Agent 未实际修改任何文件，疑似幻觉');
        }
        this.log(`[Phase 3/5] Fix 完成 — 修改了 ${diffResult.stdout.split('\n').filter(Boolean).length} 个文件:\n${diffResult.stdout.trim()}`);

        // —— Phase 4: Verify ——
        this.log(`[Phase 4/5] Verify — 运行测试验证...`);
        await state.updatePhase(repo, issue.number, 'verify');
        const verifyOk = await this.phaseVerify(agent);
        if (!verifyOk) {
          await this.rollback(ctx.workDir);
          ctx.log.push('Phase 4 Verify 失败，代码已回退');
          throw new PipelineError('verify', '测试未通过，已回退所有修改');
        }
        this.log(`[Phase 4/5] Verify — 测试通过`);

        // —— Phase 5: Submit PR ——
        this.log(`[Phase 5/5] Submit — 创建分支 + commit + push + PR...`);
        await state.updatePhase(repo, issue.number, 'submit');
        const prUrl = await this.phaseSubmit(ctx, fixResult.summary);
        ctx.log.push(`Phase 5 Submit 完成: ${prUrl}`);

        // 成功！
        await client.addComment(issue.number, buildSuccessComment(prUrl, fixResult.summary));
        await notifier?.notify({
          type: 'fix_success', repo,
          issue: { number: issue.number, title: issue.title, html_url: issue.html_url },
          prUrl, summary: fixResult.summary,
        });
        await state.markProcessed(repo, issue.number);

        return { success: true, phase: 'submit' as const, issueNumber: issue.number, prUrl, log: ctx.log };
      });

      return result;
    } catch (err) {
      if (err instanceof PipelineError) {
        return await this.handleFail(ctx, err.phase, err.message);
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      return await this.handleFail(ctx, 'execute', `异常: ${errorMsg}`);
    } finally {
      // 清理临时目录
      await fs.remove(ctx.workDir).catch(() => {});
    }
  }

  // —— Shared agent（整个流水线复用，避免重复 init）——

  private async withAgent<T>(
    ctx: PipelineContext,
    fn: (agent: SpicaAgent) => Promise<T>,
  ): Promise<T> {
    const agent = new SpicaAgent(ctx.providerName, ctx.workDir);
    try {
      // 轻量初始化：跳过 MCP/skills，只需要 LLM + tools
      await agent.initLightweight(ctx.providerName);
      return await fn(agent);
    } finally {
      agent.dispose();
    }
  }

  /** 调用 agent.runLoop 执行一次 LLM 任务 */
  private async runPhase(
    agent: SpicaAgent,
    prompt: string,
    phase: string,
    timeoutMs = 120_000,   // 默认 2 分钟，测试用
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      agent.interrupt();
    }, timeoutMs);

    try {
      const result = await agent.runLoop(prompt);
      clearTimeout(timer);
      return result || '';
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // —— Phase 1: Understand ——

  private async phaseUnderstand(
    agent: SpicaAgent,
    ctx: PipelineContext,
  ): Promise<{ severity: string; summary: string } | null> {
    const { issue } = ctx;

    // 获取评论
    let comments: GitHubComment[] = [];
    try {
      comments = await ctx.client.listComments(issue.number);
    } catch {
      // 没有评论不影响
    }

    const prompt = buildUnderstandPrompt({
      title: issue.title,
      body: issue.body || '(无正文)',
      comments: comments.map(c => `@${c.user.login}: ${c.body}`),
    });

    const response = await this.runPhase(agent, prompt, 'understand');

    // 解析 AI 输出获取 severity
    const sevMatch = response.match(/严重程度.*?\[(critical|major|minor)\]/i);
    const severity = sevMatch ? sevMatch[1].toLowerCase() : 'major';

    return { severity, summary: response };
  }

  // —— Phase 2: Reproduce ——

  private async phaseReproduce(
    agent: SpicaAgent,
    ctx: PipelineContext,
    analysis: { severity: string; summary: string },
  ): Promise<{ status: 'REPRODUCED' | 'PARTIAL' | 'CANNOT'; evidence: string; detail: string }> {
    const prompt = buildReproducePrompt(analysis.summary);
    const response = await this.runPhase(agent, prompt, 'reproduce');

    // 解析复现结果
    const statusMatch = response.match(/复现结果.*?(REPRODUCED|PARTIAL|CANNOT)/i);
    const status = (statusMatch ? statusMatch[1].toUpperCase() : 'CANNOT') as
      | 'REPRODUCED'
      | 'PARTIAL'
      | 'CANNOT';

    return {
      status,
      evidence: response,
      detail: status === 'CANNOT'
        ? (response.match(/无法复现的原因.*?:(.+?)(?:\n|$)/is)?.[1] || '未知原因').trim()
        : '',
    };
  }

  // —— Phase 3: Fix ——

  private async phaseFix(
    agent: SpicaAgent,
    ctx: PipelineContext,
    analysis: { severity: string; summary: string },
    reproEvidence: string,
  ): Promise<{ ok: boolean; error?: string; summary: string }> {
    const prompt = buildFixPrompt(
      {
        title: ctx.issue.title,
        body: ctx.issue.body || '',
        number: ctx.issue.number,
      },
      analysis.summary,
      reproEvidence,
    );

    const response = await this.runPhase(agent, prompt, 'fix', 300_000); // 5 min timeout

    // 检查是否修复成功（不含 failure indicators）
    const failureIndicators = [
      '无法修复',
      'cannot fix',
      'unable to fix',
      'I cannot',
    ];

    const isFailure = failureIndicators.some(ind =>
      response.toLowerCase().includes(ind.toLowerCase()),
    );

    if (isFailure) {
      return { ok: false, error: response.slice(0, 500), summary: '' };
    }

    return {
      ok: true,
      summary: response.slice(0, 3000),
    };
  }

  // —— Phase 4: Verify ——

  private async phaseVerify(agent: SpicaAgent): Promise<boolean> {
    const prompt = buildVerifyPrompt();
    const response = await this.runPhase(agent, prompt, 'verify', 120_000); // 2 min timeout

    return response.toUpperCase().includes('VERIFIED') &&
      !response.toUpperCase().includes('FAILED');
  }

  // —— Phase 5: Submit PR ——

  private async phaseSubmit(
    ctx: PipelineContext,
    summary: string,
  ): Promise<string> {
    const { issue, client } = ctx;

    // 生成分支名
    const slug = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const branch = `fix/issue-${issue.number}-${slug}`;

    // 获取默认分支
    let base: string;
    try {
      base = await client.getDefaultBranch();
    } catch {
      base = 'main';
    }

    // 创建分支
    await client.createBranch(ctx.workDir, branch, base);

    // commit & push
    await client.commitAndPush(
      ctx.workDir,
      branch,
      `fix: ${issue.title} (Closes #${issue.number})`,
    );

    // 创建 PR
    const pr = await client.createPR(
      `fix: ${issue.title}`,
      branch,
      base,
      buildPRBody(
        issue.number,
        issue.html_url,
        summary,
        'Phase 4 Verify: all tests passed.',
      ),
    );

    return pr.html_url;
  }

  // —— Helper ——

  /** 处理失败：留言 + 邮件 + 标记 */
  private async handleFail(
    ctx: PipelineContext,
    phase: string,
    reason: string,
  ): Promise<PipelineResult> {
    ctx.log.push(`失败: Phase ${phase} — ${reason}`);

    try {
      await ctx.client.addComment(
        ctx.issue.number,
        buildFailComment(phase, reason),
      );
    } catch (e) {
      ctx.log.push(`留言失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      await ctx.notifier?.notify({
        type: 'fix_failed',
        repo: ctx.repo,
        issue: {
          number: ctx.issue.number,
          title: ctx.issue.title,
          html_url: ctx.issue.html_url,
        },
        phase,
        error: reason,
      });
    } catch (e) {
      ctx.log.push(`邮件发送失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    await ctx.state.markFailed(ctx.repo, ctx.issue.number, `[${phase}] ${reason}`);

    return this.makeResult(ctx, false, phase, reason);
  }

  /** 回退工作目录的所有修改 */
  private async rollback(workDir: string): Promise<void> {
    try {
      const { execa } = await import('execa');
      await execa('git', ['checkout', '.'], { cwd: workDir, timeout: 30_000 });
      await execa('git', ['clean', '-fd'], { cwd: workDir, timeout: 30_000 });
    } catch {
      // 回退失败也没办法
    }
  }

  /** 构建返回值 */
  private makeResult(
    ctx: PipelineContext,
    success: boolean,
    phase: string,
    error?: string,
  ): PipelineResult {
    return {
      success,
      phase,
      issueNumber: ctx.issue.number,
      error,
      log: ctx.log,
    };
  }
}
