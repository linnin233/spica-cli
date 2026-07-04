import { execa } from 'execa';
import { resolvePath, WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';
import { join } from 'path';

function getSgPath(): string {
  return join(process.cwd(), 'node_modules', '.bin', 'sg');
}

function inferLanguageFromGlob(globPattern: string): string {
  const ext = globPattern.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    kt: 'kotlin', c: 'c', cpp: 'cpp', cc: 'cpp',
    cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
    sh: 'shell', bash: 'shell', html: 'html', css: 'css',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', sql: 'sql',
  };
  return langMap[ext] || 'unknown';
}

function inferLanguageFromPath(searchPath: string): string {
  if (searchPath === WORKSPACE) return 'unknown';
  const ext = searchPath.split('.').pop()?.toLowerCase() || '';
  const singleLangMap: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', rs: 'Rust', go: 'Go',
    java: 'Java', kt: 'Kotlin', c: 'C', cpp: 'Cpp',
    cs: 'CSharp', rb: 'Ruby', php: 'PHP',
    swift: 'Swift', sh: 'Shell', bash: 'Shell',
    html: 'Html', css: 'Css', json: 'Json',
    yaml: 'Yaml', yml: 'Yaml', md: 'Markdown', sql: 'Sql',
  };
  return singleLangMap[ext] || 'unknown';
}

export async function executeAstReplace(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = (args.pattern as string) || '';
  const rewrite = (args.rewrite as string) || '';
  const searchPath = args.path ? resolvePath(args.path as string) : WORKSPACE;
  const globFilter = args.glob as string | undefined;
  const confirm = args.confirm === true;

  if (!pattern) {
    return { success: false, error: 'pattern parameter is required' };
  }
  if (!rewrite) {
    return { success: false, error: 'rewrite parameter is required' };
  }

  let lang = (args.lang as string) || '';
  if (!lang) {
    lang = globFilter ? inferLanguageFromGlob(globFilter) : inferLanguageFromPath(searchPath);
    if (lang === 'unknown') {
      return {
        success: false,
        error: 'Could not auto-detect language. Please specify --lang (e.g., ts, js, py, rs, go)',
      };
    }
  }

  // Dry run: scan first to count matches
  const scanArgs = ['--pattern', pattern, '--lang', lang, '--json=compact'];
  if (globFilter) scanArgs.push('--globs', globFilter);
  scanArgs.push(searchPath);

  try {
    const scanResult = await execa(getSgPath(), scanArgs, {
      timeout: 30000,
      reject: false,
    });

    // sg returns exit code 1 when no matches found (with [] on stdout)
    const output = (scanResult.stdout || '').trim();

    if (scanResult.exitCode !== 0 && output !== '[]' && output !== '') {
      const errMsg = scanResult.stderr || scanResult.stdout || 'ast-grep failed';
      if (errMsg.includes('no such subcommand') || errMsg.includes('No such file')) {
        return {
          success: false,
          error: 'ast-grep is not installed. Run: npm install @ast-grep/cli',
        };
      }
      return { success: false, error: `ast_replace failed: ${errMsg.slice(0, 500)}` };
    }

    if (!output || output === '[]') {
      return { success: true, output: 'No matches found for the pattern. Nothing to replace.' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches: any[] = JSON.parse(output);
    const matchCount = Array.isArray(matches) ? matches.length : 0;

    if (matchCount === 0) {
      return { success: true, output: 'No matches found for the pattern. Nothing to replace.' };
    }

    // Collect unique files
    const files = new Set<string>();
    if (Array.isArray(matches)) {
      for (const m of matches) {
        if (m.file) files.add(m.file);
      }
    }

    if (!confirm) {
      const fileList = [...files].map(f => f.replace(WORKSPACE, '').replace(/^\//, ''));
      const fileListStr =
        fileList.length <= 5 ? fileList.join(', ') : `${fileList.slice(0, 5).join(', ')}... (${fileList.length} files)`;

      return {
        success: true,
        output:
          `Dry run: would replace ${matchCount} occurrence(s) in ${files.size} file(s): ${fileListStr}\n` +
          `Add confirm:true to apply changes.`,
      };
    }

    // Batch size warning
    if (files.size > 10) {
      return {
        success: false,
        error:
          `Would replace ${matchCount} occurrences across ${files.size} files (threshold: 10). ` +
          `Narrow the scope with path or glob, or re-run with confirm:true again to proceed.`,
      };
    }

    // Apply rewrite
    const rewriteArgs = [
      '--pattern', pattern,
      '--rewrite', rewrite,
      '--lang', lang,
      '--update-all',
    ];
    if (globFilter) rewriteArgs.push('--globs', globFilter);
    rewriteArgs.push(searchPath);

    const rewriteResult = await execa(getSgPath(), rewriteArgs, {
      timeout: 30000,
      reject: false,
    });

    if (rewriteResult.exitCode !== 0) {
      return {
        success: false,
        error: `ast_replace apply failed: ${(rewriteResult.stderr || rewriteResult.stdout).slice(0, 500)}`,
      };
    }

    const fileList = [...files].map(f => f.replace(WORKSPACE, '').replace(/^\//, ''));
    const fileListStr = fileList.length <= 5 ? fileList.join(', ') : `${fileList.slice(0, 5).join(', ')}... (+${fileList.length - 5})`;

    return {
      success: true,
      output: `Replaced ${matchCount} occurrence(s) across ${files.size} file(s): ${fileListStr}`,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `ast_replace failed: ${errMsg}` };
  }
}
