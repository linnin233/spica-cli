import { execa } from 'execa';
import { resolvePath, WORKSPACE, detectFileType } from '../helpers';
import type { ToolResult } from '../helpers';

import { join } from 'path';

function getSgPath(): string {
  return join(process.cwd(), 'node_modules', '.bin', 'sg');
}

function inferLanguageFromGlob(globPattern: string): string {
  const ext = globPattern.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    sh: 'shell',
    bash: 'shell',
    html: 'html',
    css: 'css',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
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
    yaml: 'Yaml', yml: 'Yaml', md: 'Markdown',
    sql: 'Sql',
  };
  return singleLangMap[ext] || 'unknown';
}

export async function executeAstSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = (args.pattern as string) || '';
  const searchPath = args.path ? resolvePath(args.path as string) : WORKSPACE;
  const globFilter = args.glob as string | undefined;
  const maxResults = (args.maxResults as number) || 50;

  if (!pattern) {
    return { success: false, error: 'pattern parameter is required' };
  }

  let lang = (args.lang as string) || '';
  if (!lang) {
    lang = globFilter ? inferLanguageFromGlob(globFilter) : inferLanguageFromPath(searchPath);
    if (lang === 'unknown') {
      return {
        success: false,
        error:
          'Could not auto-detect language. Please specify --lang (e.g., ts, js, py, rs, go)',
      };
    }
  }

  const sgArgs = ['--pattern', pattern, '--lang', lang, '--json=compact'];

  if (globFilter) {
    sgArgs.push('--globs', globFilter);
  }

  sgArgs.push(searchPath);

  try {
    const result = await execa(getSgPath(), sgArgs, {
      timeout: 30000,
      reject: false,
    });

    // sg returns exit code 1 when no matches found (with [] on stdout)
    const output = (result.stdout || '').trim();

    if (result.exitCode !== 0 && output !== '[]' && output !== '') {
      const errMsg = result.stderr || result.stdout || 'ast-grep failed';
      if (errMsg.includes('no such subcommand') || errMsg.includes('No such file')) {
        return {
          success: false,
          error: 'ast-grep is not installed. Run: npm install @ast-grep/cli',
        };
      }
      return { success: false, error: `ast_search failed: ${errMsg.slice(0, 500)}` };
    }

    if (!output || output === '[]') {
      return { success: true, output: 'No matches found', content: '' };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matches: any[] = JSON.parse(output);

      if (!Array.isArray(matches) || matches.length === 0) {
        return { success: true, output: 'No matches found', content: '' };
      }

      const lines: string[] = [];
      let count = 0;

      for (const match of matches) {
        if (count >= maxResults) break;

        const file = match.file?.replace(WORKSPACE, '').replace(/^\//, '') || '';
        const lineNum = (match.range?.start?.line ?? 0) + 1;
        const colNum = match.range?.start?.column ?? 0;
        const text = match.text || '';
        const metaVars = match.metaVariables?.single || {};

        let metaStr = '';
        const keys = Object.keys(metaVars);
        if (keys.length > 0) {
          const captures = keys.map(k => `${k}=${metaVars[k].text}`).join(', ');
          metaStr = ` [captures: ${captures}]`;
        }

        lines.push(`${file}:${lineNum}:${colNum}: ${text}${metaStr}`);
        count++;
      }

      const summary =
        matches.length > maxResults
          ? `Found ${matches.length} matches (showing first ${maxResults}):\n`
          : `Found ${matches.length} match(es):\n`;

      return {
        success: true,
        output: summary + lines.join('\n'),
        content: JSON.stringify(matches.slice(0, maxResults)),
      };
    } catch {
      return { success: true, output, content: output };
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: `ast_search failed: ${errMsg}` };
  }
}
