import axios from 'axios';
import { validateUrl, linkAbortSignals } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeWebSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const timeoutMs = ((args.timeout as number) || 30) * 1000;
  const engine = (args.engine as string) || 'duckduckgo';

  const externalSignal = args._abortSignal as AbortSignal | undefined;
  const abortController = new AbortController();
  const cleanupAbortLink = linkAbortSignals(externalSignal, abortController);

  const tavilyApiKey = process.env.TAVILY_API_KEY;

  try {
    // Tavily API (preferred if configured)
    if (engine === 'tavily' && tavilyApiKey) {
      try {
        const tavilyResp = await axios.post(
          'https://api.tavily.com/search',
          {
            api_key: tavilyApiKey,
            query: args.query,
            search_depth: 'basic',
            max_results: 10,
          },
          {
            timeout: timeoutMs,
            signal: abortController.signal,
          }
        );

        const data = tavilyResp.data;
        if (data.results && data.results.length > 0) {
          const tavilyResults = data.results.map(
            (r: any) => `- ${r.title}\n  ${r.url}\n  ${r.content?.slice(0, 100) || ''}`
          );
          return {
            success: true,
            output: `Tavily搜索结果 (${tavilyResults.length}个):\n\n${tavilyResults.join('\n\n')}`,
          };
        }
      } catch {
        // Tavily failed, fallback to DuckDuckGo
      }
    }

    // DuckDuckGo Instant Answer API
    const ddgResults: string[] = [];
    try {
      const instantApiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query as string)}&format=json&no_html=1&skip_disambig=1`;
      const instantResp = await axios.get(instantApiUrl, {
        timeout: 10000,
        signal: abortController.signal,
      });
      const data = instantResp.data;

      if (data.Abstract || data.Answer) {
        ddgResults.push(
          `[Instant Answer]\n${data.Answer || data.Abstract}\nSource: ${data.AbstractURL || 'DuckDuckGo'}`
        );
      }

      if (data.RelatedTopics && data.RelatedTopics.length > 0) {
        for (const topic of data.RelatedTopics.slice(0, 8)) {
          if (topic.Text && topic.FirstURL) {
            ddgResults.push(`- ${topic.Text}\n  ${topic.FirstURL}`);
          }
        }
      }

      if (ddgResults.length > 0) {
        return { success: true, output: `DuckDuckGo搜索结果:\n\n${ddgResults.join('\n\n')}` };
      }
    } catch {
      // Instant API failed, try HTML scraping
    }

    // DuckDuckGo HTML scraping (fallback)
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(args.query as string)}`;

    const searchResp = await axios.get(searchUrl, {
      timeout: Math.min(timeoutMs, 15000),
      signal: abortController.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        Connection: 'keep-alive',
      },
      maxRedirects: 5,
    });

    if (abortController.signal.aborted) {
      return { success: false, error: 'Tool execution aborted by user (ESC ESC).' };
    }

    const html = searchResp.data || '';
    if (typeof html !== 'string' || html.length === 0) {
      return {
        success: true,
        output: `Web search temporarily unavailable. Agent should proceed with available information.`,
      };
    }

    const htmlResults: string[] = [];

    // DuckDuckGo HTML format
    const titleMatches = html.matchAll(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
    );
    for (const match of titleMatches) {
      const url = match[1];
      const title = match[2].trim();
      const actualUrl = url.includes('uddg=')
        ? decodeURIComponent(url.split('uddg=')[1].split('&')[0])
        : url;
      htmlResults.push(`- ${title}\n  ${actualUrl}`);
      if (htmlResults.length >= 10) break;
    }

    // Fallback parsing if no results
    if (htmlResults.length === 0) {
      const fallbackMatches = html.matchAll(
        /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]{3,50})<\/a>/g
      );
      for (const match of fallbackMatches) {
        const url = match[1];
        const title = match[2].trim();
        if (!url.includes('duckduckgo.com') && title.length > 3) {
          htmlResults.push(`- ${title}\n  ${url}`);
          if (htmlResults.length >= 10) break;
        }
      }
    }

    const output =
      htmlResults.length > 0
        ? `DuckDuckGo搜索结果 (${htmlResults.length}个):\n\n${htmlResults.join('\n\n')}`
        : `搜索完成但未找到有效结果。\n\n建议:\n1. 设置 TAVILY_API_KEY 环境变量使用 Tavily API (推荐)\n2. 使用更具体的搜索词\n3. 尝试英文关键词\n\n提示: DuckDuckGo 可能检测到自动化请求，返回主页而非搜索结果。`;

    cleanupAbortLink();
    return { success: true, output };
  } catch (searchError: any) {
    cleanupAbortLink();
    if (
      abortController.signal.aborted ||
      searchError.code === 'ERR_CANCELED' ||
      searchError.message?.includes('abort')
    ) {
      return { success: false, error: 'Tool execution aborted by user (ESC ESC).' };
    }
    return { success: false, error: searchError.message };
  }
}

export async function executeWebFetch(args: Record<string, unknown>): Promise<ToolResult> {
  const timeoutMs = ((args.timeout as number) || 30) * 1000;
  const url = args.url as string;

  try {
    validateUrl(url);
  } catch (e: any) {
    return { success: false, error: e.message };
  }

  const externalSignal = args._abortSignal as AbortSignal | undefined;
  const abortController = new AbortController();
  const cleanupAbortLink = linkAbortSignals(externalSignal, abortController);

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const isGitHubApi = url.includes('api.github.com') || url.includes('github.com');
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: isGitHubApi
        ? 'application/vnd.github.v3+json'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cache-Control': 'no-cache',
    };
    if (isGitHubApi && githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }

    const fetchResp = await axios.get(url, {
      timeout: timeoutMs,
      signal: abortController.signal,
      headers,
      maxRedirects: 10,
      responseType: 'text',
    });

    if (abortController.signal.aborted) {
      return { success: false, error: 'Tool execution aborted by user (ESC ESC).' };
    }

    const html = fetchResp.data || '';
    if (typeof html !== 'string' || html.length === 0) {
      return { success: false, error: 'Fetch failed: No content received.' };
    }

    if (
      html.includes('Just a moment') ||
      html.includes('Checking your browser') ||
      html.includes('cf-browser-verification')
    ) {
      return {
        success: false,
        error:
          '被 Cloudflare 或类似防护拦截。建议：\n1. 设置 HTTPS_PROXY 环境变量使用代理\n2. 尝试其他来源\n3. 使用 web_search 搜索替代信息',
      };
    }

    let content = html;
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
    content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
    content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

    const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let body = bodyMatch ? bodyMatch[1] : content;

    body = body.replace(/<[^>]+>/g, ' ');
    body = body.replace(/\s+/g, ' ').trim();

    const maxLen = 10000;
    if (body.length > maxLen) {
      body = body.substring(0, maxLen) + '\n... [truncated]';
    }

    const output = title ? `标题: ${title}\n\n内容:\n${body}` : body;

    cleanupAbortLink();
    return { success: true, output };
  } catch (fetchError: any) {
    cleanupAbortLink();
    if (
      abortController.signal.aborted ||
      fetchError.code === 'ERR_CANCELED' ||
      fetchError.message?.includes('abort')
    ) {
      return { success: false, error: 'Tool execution aborted by user (ESC ESC).' };
    }

    const errorMsg = fetchError.message || '';
    const statusCode = fetchError.response?.status || '';
    const isGitHubUrl = url.includes('github.com');

    if (statusCode === 404 || errorMsg.includes('404')) {
      return {
        success: false,
        error: `404 Not Found - URL does not exist (DO NOT RETRY this URL). Error: ${errorMsg}`,
      };
    }
    if (statusCode === 403 || errorMsg.includes('403')) {
      if (isGitHubUrl) {
        return {
          success: false,
          error: `403 Forbidden - GitHub API rate limit exceeded.\n建议: 设置 GITHUB_TOKEN 环境变量 (可在 https://github.com/settings/tokens 创建).\n或者使用 gh CLI 工具 (gh auth login).`,
        };
      }
      return {
        success: false,
        error: `403 Forbidden - Access denied (DO NOT RETRY). Error: ${errorMsg}`,
      };
    }
    if (statusCode === 429 || errorMsg.includes('429')) {
      if (isGitHubUrl) {
        return {
          success: false,
          error: `429 Rate Limited - GitHub API rate limit exceeded.\n建议: 设置 GITHUB_TOKEN 环境变量.\n等待一段时间后重试。`,
        };
      }
      return {
        success: false,
        error: `429 Rate Limited - Too many requests. Wait and retry later. Error: ${errorMsg}`,
      };
    }
    if (statusCode === 401 || errorMsg.includes('401')) {
      return {
        success: false,
        error: `401 Unauthorized - Authentication required (DO NOT RETRY). Error: ${errorMsg}`,
      };
    }

    return { success: false, error: fetchError.message };
  }
}
