import { execa } from 'execa';
import { detectProjectType, WORKSPACE } from '../helpers';
import type { ToolResult, ToolEventCallback } from '../helpers';

export async function executeLint(
  args: Record<string, unknown>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  const projectType = await detectProjectType(WORKSPACE);
  const fixFlag = args.fix ? '--fix' : '';
  const files = args.files || '.';

  const lintCmd =
    projectType === 'typescript'
      ? `npx tsc --noEmit 2>&1; npx eslint ${files} ${fixFlag}`
      : projectType === 'javascript'
        ? `npx eslint ${files} ${fixFlag}`
        : projectType === 'go'
          ? `golangci-lint run ${fixFlag}`
          : projectType === 'python'
            ? `pylint ${files} 2>&1`
            : projectType === 'rust'
              ? `cargo clippy --all-targets 2>&1`
              : null;

  if (!lintCmd) {
    return { success: false, error: `No linter configured for project type: ${projectType}` };
  }

  const startTime = Date.now();
  const progressTimer = eventCallback
    ? setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        eventCallback('tool_progress', { elapsed, stage: 'linting' });
      }, 5000)
    : null;

  try {
    const lintResult = await execa(lintCmd, {
      shell: true,
      cwd: WORKSPACE,
      timeout: 60000,
      reject: false,
    });

    if (progressTimer) clearInterval(progressTimer);

    const output = lintResult.stdout + '\n' + lintResult.stderr;
    const issues = output
      .split('\n')
      .filter(
        l =>
          l.includes('error') ||
          l.includes('warning') ||
          l.includes('Error') ||
          l.includes('Warning')
      );

    return {
      success: lintResult.exitCode === 0,
      output:
        issues.length > 0
          ? `Found ${issues.length} issues:\n${issues.slice(0, 20).join('\n')}`
          : 'No lint issues found',
    };
  } catch (lintError: unknown) {
    if (progressTimer) clearInterval(progressTimer);
    return {
      success: false,
      error: lintError instanceof Error ? lintError.message : String(lintError),
    };
  }
}

export async function executeTest(
  args: Record<string, unknown>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  const projectType = await detectProjectType(WORKSPACE);
  const filter = args.filter || '';
  const coverage = args.coverage ? '--coverage' : '';

  const testCmd =
    projectType === 'typescript'
      ? `npx vitest run ${filter ? `--grep "${filter}"` : ''} ${coverage}`
      : projectType === 'javascript'
        ? `npm test ${filter ? `-- --grep "${filter}"` : ''}`
        : projectType === 'go'
          ? `go test ./... ${filter ? `-run "${filter}"` : ''} ${coverage ? '-cover' : ''}`
          : projectType === 'python'
            ? `pytest ${filter ? `-k "${filter}"` : ''} ${coverage ? '--cov' : ''}`
            : projectType === 'rust'
              ? `cargo test ${filter}`
              : null;

  if (!testCmd) {
    return { success: false, error: `No test runner configured for project type: ${projectType}` };
  }

  const startTime = Date.now();
  const progressTimer = eventCallback
    ? setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        eventCallback('tool_progress', { elapsed, stage: 'running tests' });
      }, 5000)
    : null;

  try {
    const testResult = await execa(testCmd, {
      shell: true,
      cwd: WORKSPACE,
      timeout: 120000,
      reject: false,
    });

    if (progressTimer) clearInterval(progressTimer);

    const output = testResult.stdout + '\n' + testResult.stderr;

    const passedMatch = output.match(/(\d+) passed/i);
    const failedMatch = output.match(/(\d+) failed/i);

    let summary = '';
    if (passedMatch || failedMatch) {
      const passed = passedMatch ? passedMatch[1] : '0';
      const failed = failedMatch ? failedMatch[1] : '0';
      summary = `Tests: ${passed} passed, ${failed} failed\n`;
    }

    return {
      success: testResult.exitCode === 0,
      output: summary + output.slice(-500),
    };
  } catch (testError: unknown) {
    if (progressTimer) clearInterval(progressTimer);
    return {
      success: false,
      error: testError instanceof Error ? testError.message : String(testError),
    };
  }
}
