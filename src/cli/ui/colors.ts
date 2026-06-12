// ANSI 标准配色方案
// 使用终端标准颜色，跟随用户的终端配色设置

import chalk from 'chalk';
import { padRight, getStringWidth } from './stringWidth';

// 终端标准配色（跟随终端设置）
export const COLORS = {
  // 主色调 - 使用亮色版本 (bright colors)
  primary: chalk.cyanBright,
  secondary: chalk.magentaBright,
  accent: chalk.blueBright,

  // 状态色
  success: chalk.greenBright,
  error: chalk.redBright,
  warning: chalk.yellowBright,

  // 界面色
  border: chalk.blue,
  prompt: chalk.cyanBright,
  muted: chalk.gray,
  dim: chalk.dim,

  // 特殊色
  reasoning: chalk.magenta,
  tool: chalk.cyan,
  file: chalk.blue,
  diffAdd: chalk.greenBright,
  diffRemove: chalk.redBright,

  // 权限请求
  permissionBorder: chalk.red.bold,
  permissionTitle: chalk.red.bold,
  permissionText: chalk.whiteBright,

  // Bypass模式
  bypass: chalk.yellow,
  bypassAuto: chalk.yellowBright,

  // 子agent
  subAgent: chalk.gray,

  // 背景 - ANSI 不支持自定义背景色，使用标准背景
  bg: chalk.bgBlack,
  bgAlt: chalk.bgBlackBright,
  bgBorder: chalk.bgBlack,
};

// ANSI背景色控制
export const BG = {
  _bannerStopSignal: false,
  _compressStopSignal: false,

  banner: (): Promise<void> => {
    const reset = '\x1b[0m';
    const esc = '\x1b';
    const lines = [
      '              _)              ',
      '   __|  __ \\   |   __|   _` | ',
      ' \\__ \\  |   |  |  (     (   | ',
      ' ____/  .__/  _| \\___| \\__,_| ',
      '       _|                     ',
    ];

    BG._bannerStopSignal = false;

    return new Promise<void>(resolve => {
      // Use chalk colors to follow terminal theme
      const bright = chalk.cyanBright;
      const normal = chalk.cyan;

      process.stdout.write('\n');
      lines.forEach(line => process.stdout.write(bright(line) + '\n'));

      const animate = () => {
        if (BG._bannerStopSignal) {
          resolve();
          return;
        }

        const color = Date.now() % 1000 < 500 ? bright : normal;

        process.stdout.write(esc + '[5A');
        lines.forEach(line => process.stdout.write(color(line) + reset + '\n'));

        setTimeout(animate, 500);
      };

      setTimeout(animate, 500);
    });
  },

  stopBanner: () => {
    BG._bannerStopSignal = true;
  },

  // Compression spinner - shows during context compression
  compressSpinner: (): Promise<void> => {
    const reset = '\x1b[0m';
    const esc = '\x1b';
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    BG._compressStopSignal = false;

    return new Promise<void>(resolve => {
      let frameIndex = 0;

      const spin = async () => {
        while (!BG._compressStopSignal) {
          const frame = frames[frameIndex % frames.length];
          // Use chalk to follow terminal theme
          process.stdout.write(chalk.cyanBright(frame + ' Compressing...') + reset);
          await new Promise(r => setTimeout(r, 80));
          // Clear line
          process.stdout.write(esc + '[2K' + esc + '[1G');
          frameIndex++;
        }
        resolve();
      };

      spin();
    });
  },

  stopCompress: () => {
    BG._compressStopSignal = true;
  },
};

// 兼容别名（旧代码引用 LAIN_COLORS）
export const LAIN_COLORS = COLORS;

// 格式化函数
export const format = {
  prompt: () => COLORS.prompt('>'),
  success: (text: string) => COLORS.success(text),
  error: (text: string) => COLORS.error(text),
  warning: (text: string) => COLORS.warning(text),
  toolCall: (name: string) => COLORS.tool(`- ${name}`),
  toolResult: (name: string, success: boolean, output: string) => {
    const icon = success ? COLORS.success('OK') : COLORS.error('FAIL');
    return `${icon} ${name}: ${output}`;
  },
  reasoning: (content: string) => COLORS.reasoning(content),
  diffFile: (path: string) => COLORS.file(`file: ${path}`),
  diffAdd: (line: string) => COLORS.diffAdd(`+ ${line}`),
  diffRemove: (line: string) => COLORS.diffRemove(`- ${line}`),
  permissionBox: (reason: string) => {
    const border = COLORS.permissionBorder;
    const title = COLORS.permissionTitle;
    const text = COLORS.permissionText;
    const dimBorder = COLORS.muted('─'.repeat(50));
    return `
${border('═'.repeat(50))}
${title('  [!] PERMISSION REQUIRED')}
${border('═'.repeat(50))}
${text(`  Action: ${reason}`)}
${dimBorder}
`;
  },
  status: (bypass: boolean, msgs: number, workspace: string) => {
    const mode = bypass ? COLORS.warning('BYPASS') : COLORS.success('STRICT');
    return `
${COLORS.primary.bold('Current Status:')}
  Permission mode: ${mode}
  Messages in context: ${msgs}
  Workspace: ${workspace}
`;
  },
  muted: (text: string) => COLORS.muted(text),
  dim: (text: string) => COLORS.dim(text),
  // 表格格式化（支持中英文对齐）
  tableRow: (columns: string[], widths: number[]) => {
    return columns
      .map((col, i) => {
        const padded = padRight(col, widths[i] || 10);
        return COLORS.muted(padded);
      })
      .join(' | ');
  },
  // 状态表格
  statusTable: (items: Array<{ label: string; value: string }>) => {
    const maxLabelWidth = Math.max(...items.map(i => getStringWidth(i.label))) + 2;
    return items
      .map(i => {
        const label = padRight(i.label + ':', maxLabelWidth);
        return `  ${COLORS.muted(label)} ${COLORS.primary(i.value)}`;
      })
      .join('\n');
  },
};
