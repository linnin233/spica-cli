import simpleGit from 'simple-git';
import { execa } from 'execa';
import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeGit(safeArgs: Record<string, any>): Promise<ToolResult> {
  const git = simpleGit(WORKSPACE);
  const action = safeArgs.action as string;
  const args = safeArgs.args || {};

  switch (action) {
    case 'status': {
      const status = await git.status();
      return {
        success: true,
        output: status.files.map(f => `${f.index} ${f.path}`).join('\n') || 'clean',
      };
    }
    case 'diff': {
      const diff = await git.diff();
      return { success: true, output: diff || 'No changes' };
    }
    case 'log': {
      const log = await git.log({ maxCount: args.limit || 10 });
      return {
        success: true,
        output: log.all.map(c => `${c.hash.substring(0, 7)} ${c.message}`).join('\n'),
      };
    }
    case 'add': {
      await git.add(args.files || '.');
      return { success: true, output: 'Files added' };
    }
    case 'commit': {
      if (!args.message) return { success: false, error: 'Message required' };
      await git.commit(args.message);
      return { success: true, output: `Committed: ${args.message}` };
    }
    case 'branch': {
      if (args.branch) {
        await git.branch(args.branch);
        return { success: true, output: `Created branch: ${args.branch}` };
      }
      const branches = await git.branchLocal();
      return { success: true, output: branches.all.join('\n') };
    }
    case 'checkout': {
      const branchName = String(args.branch || '');
      if (!branchName) return { success: false, error: 'Branch required' };

      // 安全检查：检测未提交更改
      const status = await git.status();
      if (status.files.length > 0) {
        // 不直接执行，返回教育性错误让AI决定如何处理
        const fileList = status.files
          .slice(0, 10)
          .map(f => f.path)
          .join('\n');
        return {
          success: false,
          error: `未提交更改存在 (${status.files.length} files)，切换分支将丢失工作。\n建议安全操作顺序：\n1. git action:stash (保存当前工作)\n2. git action:checkout (安全切换)\n3. git action:stash_pop (恢复工作)\n\n或者提交当前工作：\n1. git action:add files:. (添加所有文件)\n2. git action:commit message:"work in progress" (提交)\n3. git action:checkout (安全切换)\n\n受影响文件：\n${fileList}${status.files.length > 10 ? '\n... 更多文件' : ''}`,
          filesAtRisk: status.files.map(f => f.path),
          safetyMode: 'protected',
        };
      }

      // 安全：可以切换分支
      const branches = await git.branchLocal();
      if (branches.all.includes(branchName)) {
        await git.checkout(branchName);
        return { success: true, output: `Switched to ${branchName}` };
      }
      await git.checkoutLocalBranch(branchName);
      return { success: true, output: `Created and switched to ${branchName}` };
    }
    case 'push': {
      await git.push();
      return { success: true, output: 'Pushed' };
    }
    case 'pull': {
      await git.pull();
      return { success: true, output: 'Pulled' };
    }
    case 'reset': {
      // 安全检查：所有reset模式都需要检查未提交更改
      const status = await git.status();
      const mode = args.mode || 'mixed';

      if (status.files.length > 0 && (mode === 'hard' || mode === 'mixed')) {
        const fileList = status.files
          .slice(0, 10)
          .map(f => f.path)
          .join('\n');
        const warningMsg =
          mode === 'hard'
            ? `Reset --hard 将永久丢失 ${status.files.length} 个文件的所有更改！`
            : `Reset --mixed 将取消 ${status.files.length} 个文件的暂存状态`;

        return {
          success: false,
          error: `${warningMsg}\n建议安全操作：\n1. git action:stash (保存工作)\n2. git action:reset mode:${mode} (执行reset)\n3. 如需恢复：git action:stash_pop\n\n受影响文件：\n${fileList}${status.files.length > 10 ? '\n... 更多文件' : ''}\n\n如确认继续，请明确说明：用户已确认reset操作`,
          filesAtRisk: status.files.map(f => f.path),
          safetyMode: 'protected',
          requiresUserConfirmation: true,
        };
      }

      // 执行reset（已确认安全或clean状态）
      await git.reset(mode);
      return { success: true, output: `Reset (${mode}) completed safely` };
    }
    case 'stash': {
      const stashAction = args.stash_action || 'push';

      if (stashAction === 'push' || stashAction === 'save') {
        const message = args.message || `spica-auto-backup-${Date.now()}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await git.stash({ message } as any);
        return { success: true, output: `Stashed: ${message}` };
      } else if (stashAction === 'pop') {
        await execa('git stash pop', { shell: true, cwd: WORKSPACE });
        return { success: true, output: 'Stash restored' };
      } else if (stashAction === 'apply') {
        await execa('git stash apply', { shell: true, cwd: WORKSPACE });
        return { success: true, output: 'Stash applied' };
      } else if (stashAction === 'list') {
        const stashList = await git.stashList();
        return {
          success: true,
          output:
            stashList.all.map(s => `${s.hash.substring(0, 7)} ${s.message}`).join('\n') ||
            'No stashes',
        };
      } else if (stashAction === 'drop') {
        await execa('git stash drop', { shell: true, cwd: WORKSPACE });
        return { success: true, output: 'Stash dropped' };
      }

      return { success: false, error: `Unknown stash action: ${stashAction}` };
    }
    default:
      return { success: false, error: `Unknown git action: ${action}` };
  }
}
