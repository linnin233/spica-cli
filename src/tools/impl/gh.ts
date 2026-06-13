import { execa } from 'execa';
import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeGh(args: Record<string, any>): Promise<ToolResult> {
  const action = args.action as string;
  const ghArgs_sub = args.args || {};
  const timeout = (ghArgs_sub.timeout || 15) * 1000;

  switch (action) {
    case 'pr_view': {
      const ghArgs = ['pr', 'view'];
      if (ghArgs_sub.number) ghArgs.push(String(ghArgs_sub.number));
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
    }
    case 'pr_list': {
      const state = ghArgs_sub.state || 'open';
      const limit = ghArgs_sub.limit || 20;
      const ghResult = await execa(
        'gh',
        ['pr', 'list', '--state', state, '--limit', String(limit)],
        { cwd: WORKSPACE, timeout, reject: false }
      );
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || 'No PRs found' };
    }
    case 'pr_create': {
      const title = ghArgs_sub.title || '';
      const body = ghArgs_sub.body || '';
      const base = ghArgs_sub.base || 'main';
      const head = ghArgs_sub.head || '';
      if (!title) return { success: false, error: 'Title required' };
      const ghArgs = ['pr', 'create', '--title', title, '--body', body, '--base', base];
      if (head) ghArgs.push('--head', head);
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
    }
    case 'issue_list': {
      const state = ghArgs_sub.state || 'open';
      const limit = ghArgs_sub.limit || 20;
      const ghArgs = ['issue', 'list', '--state', state, '--limit', String(limit)];
      if (ghArgs_sub.label) ghArgs.push('--label', ghArgs_sub.label);
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || 'No issues found',
      };
    }
    case 'issue_view': {
      const ghArgs = ['issue', 'view'];
      if (ghArgs_sub.number) ghArgs.push(String(ghArgs_sub.number));
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
    }
    case 'issue_create': {
      const title = ghArgs_sub.title || '';
      const body = ghArgs_sub.body || '';
      if (!title) return { success: false, error: 'Title required' };
      const ghResult = await execa(
        'gh',
        ['issue', 'create', '--title', title, '--body', body],
        { cwd: WORKSPACE, timeout, reject: false }
      );
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
    }
    case 'repo_view': {
      const ghResult = await execa('gh', ['repo', 'view'], {
        cwd: WORKSPACE,
        timeout,
        reject: false,
      });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || 'Not in a GitHub repository',
      };
    }
    case 'run_list': {
      const limit = ghArgs_sub.limit || 10;
      const ghResult = await execa('gh', ['run', 'list', '--limit', String(limit)], {
        cwd: WORKSPACE,
        timeout,
        reject: false,
      });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || 'No workflow runs found',
      };
    }
    case 'run_view': {
      const ghArgs = ['run', 'view'];
      if (ghArgs_sub.number) ghArgs.push(String(ghArgs_sub.number));
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
    }
    case 'pr_comment': {
      if (!ghArgs_sub.number) return { success: false, error: 'PR number required' };
      const ghArgs = ['pr', 'comment', String(ghArgs_sub.number)];
      if (ghArgs_sub.body) ghArgs.push('--body', ghArgs_sub.body);
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || 'Comment posted',
      };
    }
    case 'pr_review': {
      if (!ghArgs_sub.number) return { success: false, error: 'PR number required' };
      const reviewAction = ghArgs_sub.action || 'comment';
      const ghArgs = ['pr', 'review', String(ghArgs_sub.number), `--${reviewAction}`];
      if (ghArgs_sub.body) ghArgs.push('--body', ghArgs_sub.body);
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || `Review (${reviewAction}) submitted`,
      };
    }
    case 'pr_merge': {
      if (!ghArgs_sub.number) return { success: false, error: 'PR number required' };
      const mergeMethod = ghArgs_sub.method || 'squash';
      const ghArgs = ['pr', 'merge', String(ghArgs_sub.number), `--${mergeMethod}`];
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || `PR merged (${mergeMethod})`,
      };
    }
    case 'pr_diff': {
      if (!ghArgs_sub.number) return { success: false, error: 'PR number required' };
      const ghResult = await execa('gh', ['pr', 'diff', String(ghArgs_sub.number)], {
        cwd: WORKSPACE,
        timeout,
        reject: false,
      });
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || 'No diff' };
    }
    case 'issue_comment': {
      if (!ghArgs_sub.number) return { success: false, error: 'Issue number required' };
      const ghArgs = ['issue', 'comment', String(ghArgs_sub.number)];
      if (ghArgs_sub.body) ghArgs.push('--body', ghArgs_sub.body);
      const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
      return {
        success: ghResult.exitCode === 0,
        output: ghResult.stdout || 'Comment posted',
      };
    }
    case 'search': {
      const searchType = ghArgs_sub.type || 'code';
      const searchQuery = ghArgs_sub.query || '';
      if (!searchQuery) return { success: false, error: 'Search query required' };
      const searchLimit = ghArgs_sub.limit || 10;
      const ghResult = await execa(
        'gh',
        ['search', searchType, searchQuery, '--limit', String(searchLimit)],
        { cwd: WORKSPACE, timeout, reject: false }
      );
      return { success: ghResult.exitCode === 0, output: ghResult.stdout || 'No results' };
    }
    default:
      return { success: false, error: `Unknown gh action: ${action}` };
  }
}
