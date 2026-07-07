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

// —— Pipeline ——

export class BugPipeline {
  private providerName: string;

  constructor(providerName?: string) {
    this.providerName = providerName || 'default';
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
      await state.markProcessing(repo, issue.number, 'start');
      await client.addComment(issue.number, buildStartComment());
      ctx.log.push('已留言 "开始处理"');

      // —— Phase 1: Understand ——
      await state.updatePhase(repo, issue.number, 'understand');
      const analysis = await this.phaseUnderstand(ctx);
      if (!analysis) {
        return await this.handleFail(ctx, 'understand', 'AI 无法理解 issue 内容');
      }
      ctx.log.push(`Phase 1 Understand 完成: 严重程度=${analysis.severity}`);

      // —— Phase 2: Reproduce ——
      await state.updatePhase(repo, issue.number, 'reproduce');
      const repro = await this.phaseReproduce(ctx, analysis);
      if (repro.status === 'CANNOT') {
        await client.addComment(
          issue.number,
          buildCannotReproduceComment(repro.detail),
        );
        ctx.log.push('Phase 2 Reproduce: CANNOT — 已留言请求更多信息');
        await notifier?.notify({
          type: 'fix_blocked',
          repo,
          issue: { number: issue.number, title: issue.title, html_url: issue.html_url },
          error: repro.detail,
        });
        await state.markFailed(repo, issue.number, `CANNOT reproduce: ${repro.detail}`);
        return this.makeResult(ctx, false, 'reproduce', '无法复现');
      }
      ctx.log.push(`Phase 2 Reproduce 完成: ${repro.status}`);

      // —— Phase 3: Fix ——
      await state.updatePhase(repo, issue.number, 'fix');
      const fixResult = await this.phaseFix(ctx, analysis, repro.evidence);
      if (!fixResult.ok) {
        return await this.handleFail(ctx, 'fix', fixResult.error || '修复失败');
      }
      ctx.log.push('Phase 3 Fix 完成');

      // —— Phase 4: Verify ——
      await state.updatePhase(repo, issue.number, 'verify');
      const verifyOk = await this.phaseVerify(ctx);
      if (!verifyOk) {
        // 回退修改
        await this.rollback(ctx.workDir);
        ctx.log.push('Phase 4 Verify 失败 — 回退修改');
        return await this.handleFail(ctx, 'verify', '验证失败：测试未通过，已回退所有修改');
      }
      ctx.log.push('Phase 4 Verify 完成: 所有测试通过');

      // —— Phase 5: Submit PR ——
      await state.updatePhase(repo, issue.number, 'submit');
      const prUrl = await this.phaseSubmit(ctx, fixResult.summary);
      ctx.log.push(`Phase 5 Submit 完成: ${prUrl}`);

      // 成功！
      await client.addComment(
        issue.number,
        buildSuccessComment(prUrl, fixResult.summary),
      );
      await notifier?.notify({
        type: 'fix_success',
        repo,
        issue: { number: issue.number, title: issue.title, html_url: issue.html_url },
        prUrl,
        summary: fixResult.summary,
      });
      await state.markProcessed(repo, issue.number);

      return {
        success: true,
        phase: 'submit',
        issueNumber: issue.number,
        prUrl,
        log: ctx.log,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return await this.handleFail(ctx, 'execute', `异常: ${errorMsg}`);
    } finally {
      // 清理临时目录
      await fs.remove(ctx.workDir).catch(() => {});
    }
  }

  // —— Phase 1: Understand ——

  private async phaseUnderstand(
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

    const response = await this.callAgent(ctx, prompt, 'understand');

    // 解析 AI 输出获取 severity
    const sevMatch = response.match(/严重程度.*?\[(critical|major|minor)\]/i);
    const severity = sevMatch ? sevMatch[1].toLowerCase() : 'major';

    return { severity, summary: response };
  }

  // —— Phase 2: Reproduce ——

  private async phaseReproduce(
    ctx: PipelineContext,
    analysis: { severity: string; summary: string },
  ): Promise<{ status: 'REPRODUCED' | 'PARTIAL' | 'CANNOT'; evidence: string; detail: string }> {
    const prompt = buildReproducePrompt(analysis.summary);
    const response = await this.callAgent(ctx, prompt, 'reproduce');

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

    const response = await this.callAgent(ctx, prompt, 'fix', 1_800_000); // 30 min timeout

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
      summary: response.slice(0, 3000), // PR 摘要
    };
  }

  // —— Phase 4: Verify ——

  private async phaseVerify(ctx: PipelineContext): Promise<boolean> {
    const prompt = buildVerifyPrompt();
    const response = await this.callAgent(ctx, prompt, 'verify', 600_000); // 10 min timeout

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

  /** 调用 SpicaAgent 执行 AI 任务 */
  private async callAgent(
    ctx: PipelineContext,
    prompt: string,
    phase: string,
    timeoutMs = 300_000, // default 5 min
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.interrupt();
        reject(new Error(`Phase ${phase} 超时 (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      const agent = new SpicaAgent(ctx.providerName, ctx.workDir);

      const initAndRun = async () => {
        try {
          await agent.init();
          const result = await agent.runLoop(prompt);
          clearTimeout(timer);
          resolve(result || '');
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        } finally {
          agent.dispose();
        }
      };

      initAndRun();
    });
  }

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
