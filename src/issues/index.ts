/**
 * Issue 自动处理模块入口
 * 注册 CLI 命令: spica issue daemon / once / run
 */

import type { Command } from 'commander';
import { join } from 'path';
import { homedir } from 'os';
import {
  loadGlobalSettings,
  getProviderConfig,
  getGithubConfig,
  getEmailConfig,
} from '../utils/settings';
import { GitHubClient } from './github';
import { IssuePoller } from './poller';
import { BugPipeline } from './pipeline';
import { Notifier } from './notify';
import { IssueStateManager } from './state';
import { COLORS } from '../cli/ui/colors';

/** 状态文件路径 */
function getStateFile(): string {
  return join(homedir(), '.spica', 'issues', 'state.json');
}

/** 注册 issue 子命令到 Commander */
export function registerIssueCommands(program: Command): void {
  const issueCmd = program
    .command('issue')
    .description('Auto issue handler -- 自动处理 GitHub issues');

  // 辅助函数：解析 provider name（优先 CLI 参数，然后 settings 默认值，最后 "openai"）
  async function resolveProvider(cliProvider?: string): Promise<string> {
    if (cliProvider) return cliProvider;
    const settings = await loadGlobalSettings();
    return settings.defaultProvider || 'openai';
  }

  // spica issue daemon -- 后台守护轮询
  issueCmd
    .command('daemon')
    .description('启动后台轮询，持续处理 issues')
    .option('-p, --provider <name>', 'LLM provider')
    .action(async options => {
      const settings = await loadGlobalSettings();
      const github = getGithubConfig(settings);
      if (!github || github.repos.length === 0) {
        console.log(COLORS.error('未配置 github 或 repos 为空。请在 settings.json 中配置。'));
        return;
      }

      const email = getEmailConfig(settings);
      if (!email) {
        console.log(COLORS.warning('未配置 email，将不会发送邮件通知。'));
      }

      const notifier = email ? new Notifier(email) : null;
      const state = new IssueStateManager(getStateFile());
      await state.load();

      // 恢复滞留的 processing 条目
      const stale = state.recoverStale();
      if (stale.length > 0) {
        console.log(
          COLORS.warning(`恢复 ${stale.length} 个滞留的 processing 条目`),
        );
      }
      await state.save();

      // 创建流水线
      const pipeline = new BugPipeline(await resolveProvider(options.provider), msg => console.log(`  ${msg}`));

      // 创建轮询器（daemon）
      const poller = new IssuePoller(github.token, {
        repos: github.repos,
        labels: github.labels,
        pollInterval: github.pollInterval,
      }, state);

      // 同仓库串行队列：防止并行处理时互相覆盖修改
      const repoQueues: Record<string, Promise<void>> = {};

      // 绑定事件：新 issue → 流水线处理
      poller.on('new_issue', async ({ repo, issue }) => {
        console.log(
          `[新 Issue] ${repo}#${issue.number}: ${issue.title.slice(0, 80)}`,
        );

        // 获取或创建该仓库的处理队列（串行）
        const prev = repoQueues[repo] || Promise.resolve();
        const task = prev.then(async () => {
          try {
            const client = new GitHubClient(github.token, repo);
            const result = await pipeline.execute(
              client, repo, issue, notifier, state,
            );

            if (result.success) {
              console.log(
                COLORS.success(`[OK] #${issue.number} → ${result.prUrl}`),
              );
            } else {
              console.log(
                COLORS.error(`[FAIL] #${issue.number}: ${result.error}`),
              );
            }
          } catch (err) {
            console.error(
              COLORS.error(`处理 issue #${issue.number} 异常: ${err instanceof Error ? err.message : String(err)}`),
            );
          }
        });
        repoQueues[repo] = task;
      });

      // 绑定错误事件
      poller.on('poll_error', ({ repo, error }) => {
        console.error(COLORS.error(`[轮询错误] ${repo}: ${error}`));
      });

      // 优雅退出
      const shutdown = () => {
        console.log(COLORS.warning('\n正在停止轮询器...'));
        poller.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // 启动！
      await poller.start();
      console.log(COLORS.success('Issue daemon 已启动，等待 issues...'));
    });

  // spica issue once [repo] — 一次性处理
  issueCmd
    .command('once [repo]')
    .description('一次性处理所有未处理的 issues')
    .option('-p, --provider <name>', 'LLM provider')
    .action(async (repo: string | undefined, options) => {
      const settings = await loadGlobalSettings();
      const github = getGithubConfig(settings);
      if (!github || github.repos.length === 0) {
        console.log(COLORS.error('未配置 github 或 repos 为空。'));
        return;
      }

      const repos = repo ? [repo] : github.repos;
      const email = getEmailConfig(settings);
      const notifier = email ? new Notifier(email) : null;
      const state = new IssueStateManager(getStateFile());
      await state.load();

      const pipeline = new BugPipeline(await resolveProvider(options.provider), msg => console.log(`  ${msg}`));
      const poller = new IssuePoller(github.token, {
        repos,
        labels: github.labels,
        pollInterval: github.pollInterval,
      }, state);

      console.log(COLORS.muted(`检查 ${repos.join(', ')} 的 issues...`));
      const issues = await poller.checkOnce();

      if (issues.length === 0) {
        console.log(COLORS.success('没有未处理的 issues。'));
        return;
      }

      console.log(COLORS.muted(`发现 ${issues.length} 个新 issues，开始处理...`));

      for (const { repo: r, issue } of issues) {
        console.log(COLORS.muted(`处理 ${r}#${issue.number}: ${issue.title.slice(0, 80)}`));

        const client = new GitHubClient(github.token, r);
        const result = await pipeline.execute(client, r, issue, notifier, state);

        if (result.success) {
          console.log(COLORS.success(`[OK] → ${result.prUrl}`));
        } else {
          console.log(COLORS.error(`[FAIL] Phase ${result.phase}: ${result.error}`));
        }
      }

      console.log(COLORS.success('全部处理完成。'));
    });

  // spica issue run <repo>#<number> — 单个执行
  issueCmd
    .command('run <repoAndNumber>')
    .description('手动处理单个 issue（调试用）')
    .option('-p, --provider <name>', 'LLM provider')
    .action(async (repoAndNumber: string, options) => {
      const match = repoAndNumber.match(/^(.+)#(\d+)$/);
      if (!match) {
        console.log(COLORS.error('格式错误。示例: spica issue run owner/repo#123'));
        return;
      }

      const [, repo, numStr] = match;
      const issueNum = parseInt(numStr, 10);

      const settings = await loadGlobalSettings();
      const github = getGithubConfig(settings);
      if (!github) {
        console.log(COLORS.error('未配置 github token。'));
        return;
      }

      const email = getEmailConfig(settings);
      const notifier = email ? new Notifier(email) : null;
      const state = new IssueStateManager(getStateFile());
      await state.load();

      const client = new GitHubClient(github.token, repo);

      // 获取 issue
      let issue;
      try {
        issue = await client.getIssue(issueNum);
        console.log(COLORS.muted(`获取 issue #${issueNum}: ${issue.title}`));
      } catch (err) {
        console.log(COLORS.error(`获取 issue 失败: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      const pipeline = new BugPipeline(await resolveProvider(options.provider), msg => console.log(`  ${msg}`));
      const result = await pipeline.execute(client, repo, issue, notifier, state);

      if (result.success) {
        console.log(COLORS.success(`\n[完成] PR: ${result.prUrl}`));
      } else {
        console.log(COLORS.error(`\n[失败] Phase ${result.phase}: ${result.error}`));
      }

      // 打印日志
      console.log(COLORS.muted('\n处理日志:'));
      for (const line of result.log) {
        console.log(COLORS.muted(`  - ${line}`));
      }
    });
}
