/**
 * 邮件通知模块
 * 手写 SMTP 客户端（net 模块），纯文本邮件，无额外 npm 依赖
 * 处理失败时通知管理员人工介入
 */

import { connect } from 'net';
import { connect as tlsConnect } from 'tls';
import type { EmailConfig } from '../utils/settings';

/** SSL 端口列表（需要 TLS 加密的端口） */
const SSL_PORTS = [465, 587];

// —— 类型 ——

export interface NotificationEvent {
  type: 'fix_success' | 'fix_failed' | 'fix_blocked';
  repo: string;
  issue: { number: number; title: string; html_url: string };
  phase?: string;              // 失败的阶段
  error?: string;              // 失败原因
  prUrl?: string;              // 成功时 PR 地址
  summary?: string;            // 修复摘要
}

export class Notifier {
  private config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  /** 发送通知邮件 */
  async notify(event: NotificationEvent): Promise<void> {
    const subject = this.buildSubject(event);
    const body = this.buildBody(event);
    await this.sendMail(subject, body);
  }

  /** 构建邮件主题 */
  private buildSubject(event: NotificationEvent): string {
    const prefix = event.type === 'fix_success'
      ? '[OK]'
      : event.type === 'fix_blocked'
        ? '[BLOCKED]'
        : '[FAILED]';
    return `${prefix} Issue #${event.issue.number}: ${event.issue.title.slice(0, 60)}`;
  }

  /** 构建邮件正文 */
  private buildBody(event: NotificationEvent): string {
    const lines: string[] = [];
    lines.push(`仓库: ${event.repo}`);
    lines.push(`Issue: ${event.issue.title} (#${event.issue.number})`);
    lines.push(`链接: ${event.issue.html_url}`);
    lines.push('');

    switch (event.type) {
      case 'fix_success':
        lines.push(`状态: 修复完成`);
        lines.push(`PR: ${event.prUrl || 'N/A'}`);
        if (event.summary) {
          lines.push('');
          lines.push('修改摘要:');
          lines.push(event.summary);
        }
        break;
      case 'fix_failed':
        lines.push(`状态: 处理失败`);
        lines.push(`失败阶段: ${event.phase || 'unknown'}`);
        if (event.error) {
          lines.push(`原因: ${event.error}`);
        }
        lines.push('');
        lines.push('需要人工介入处理。');
        break;
      case 'fix_blocked':
        lines.push(`状态: 被阻塞（无法复现）`);
        if (event.error) {
          lines.push(`原因: ${event.error}`);
        }
        lines.push('');
        lines.push('AI 无法复现此 bug，已留言请求更多信息。');
        lines.push('请查看 issue 并提供补充信息。');
        break;
    }

    lines.push('');
    lines.push('---');
    lines.push(`由 spica-cli auto-issue-handler 自动发送`);
    lines.push(`时间: ${new Date().toISOString()}`);

    return lines.join('\n');
  }

  /** SMTP 发信 */
  private async sendMail(subject: string, body: string): Promise<void> {
    const { host, port, user, pass, to } = this.config;
    const useSSL = SSL_PORTS.includes(port);

    return new Promise((resolve, reject) => {
      // 端口 465/587 → TLS 加密连接，否则明文
      const socket = useSSL
        ? tlsConnect(port, host, { rejectUnauthorized: false })
        : connect(port, host);

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`SMTP 连接 ${host}:${port} 超时`));
      }, 15_000);

      socket.setEncoding('utf8');

      let buffer = '';
      let step = 0; // 0=等待220, 1=EHLO, 2=AUTH, 3=MAIL, 4=RCPT, 5=DATA, 6=发送内容, 7=QUIT

      const sendLine = (line: string) => {
        socket.write(line + '\r\n');
      };

      const base64 = (s: string) => Buffer.from(s).toString('base64');

      socket.on('data', (chunk: string) => {
        buffer += chunk;

        // 检查是否收到完整响应行（以 \r\n 结尾）
        while (buffer.includes('\r\n')) {
          const end = buffer.indexOf('\r\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);

          const code = parseInt(line.slice(0, 3), 10) || 0;

          // SMTP 错误码：4xx/5xx 开头（QUIT 阶段跳过）
          if (code >= 400 && step !== 7) {
            clearTimeout(timeout);
            socket.end();
            reject(new Error(`SMTP 错误: ${line}`));
            return;
          }

          // 多行响应（以 - 分隔前三位），跳过直到最后一行
          if (line[3] === '-') continue;

          switch (step) {
            case 0: // 等待 220
              if (code === 220) {
                step = 1;
                sendLine(`EHLO spica-cli`);
              }
              break;
            case 1: // EHLO 响应 → 开始 AUTH
              step = 2;
              sendLine('AUTH LOGIN');
              break;
            case 2: // AUTH 提示输入用户名
              step = 3;
              sendLine(base64(user));
              break;
            case 3: // 用户名 OK → 输入密码
              step = 4;
              sendLine(base64(pass));
              break;
            case 4: // 密码 OK → MAIL FROM
              step = 5;
              sendLine(`MAIL FROM:<${user}>`);
              break;
            case 5: // MAIL FROM OK → RCPT TO
              step = 6;
              sendLine(`RCPT TO:<${to}>`);
              break;
            case 6: // RCPT TO OK → DATA
              step = 7;
              sendLine('DATA');
              break;
            case 7: // DATA 提示 354 → 发送邮件内容
              step = 8;
              sendLine(`From: spica-cli <${user}>`);
              sendLine(`To: <${to}>`);
              sendLine(`Subject: =?UTF-8?B?${base64(subject)}?=`);
              sendLine('Content-Type: text/plain; charset=UTF-8');
              sendLine('Content-Transfer-Encoding: 8bit');
              sendLine('');
              sendLine(body);
              sendLine('.');
              break;
            case 8: // 内容已接收（250）→ QUIT
              step = 9;
              sendLine('QUIT');
              break;
            case 9: // QUIT OK（221）
              clearTimeout(timeout);
              socket.end();
              resolve();
              break;
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`SMTP ${useSSL ? 'SSL ' : ''}连接失败: ${err.message}`));
      });

      socket.on('close', () => {
        if (step < 9) {
          clearTimeout(timeout);
          reject(new Error('SMTP 连接意外关闭'));
        }
      });
    });
  }
}
