// Diff显示 - 格式化文件变更对比 (清晰格式)

import chalk from 'chalk';

// 配色
const DIFF_ADD = chalk.hex('#00FA9A'); // 春绿 - 新增
const DIFF_REMOVE = chalk.hex('#FF6B6B'); // 淡红 - 删除
const DIFF_CONTEXT = chalk.hex('#696969'); // 暗灰 - 上下文
const DIFF_HEADER = chalk.hex('#87CEEB'); // 天蓝 - 头部

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
}

// 计算简单diff（优化算法）
export function computeDiff(oldContent: string, newContent: string): DiffLine[] {
  // 处理空内容：空字符串 split('\n') 返回 ['']，需要过滤
  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');
  const diff: DiffLine[] = [];

  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const oldLine = oldLines[oldIdx];
    const newLine = newLines[newIdx];

    if (oldIdx >= oldLines.length) {
      // 只有新内容（新增）
      diff.push({ type: 'add', content: newLine, newLine: newIdx + 1 });
      newIdx++;
    } else if (newIdx >= newLines.length) {
      // 只有旧内容（删除）
      diff.push({ type: 'remove', content: oldLine, oldLine: oldIdx + 1 });
      oldIdx++;
    } else if (oldLine === newLine) {
      // 相同（上下文）
      diff.push({ type: 'context', content: oldLine, oldLine: oldIdx + 1, newLine: newIdx + 1 });
      oldIdx++;
      newIdx++;
    } else {
      // 不同 - 检查是否是新增或删除
      const nextOldMatch = oldLines.slice(oldIdx + 1).indexOf(newLine);
      const nextNewMatch = newLines.slice(newIdx + 1).indexOf(oldLine);

      if (nextOldMatch !== -1 && (nextNewMatch === -1 || nextOldMatch <= nextNewMatch)) {
        // 旧内容有删除
        diff.push({ type: 'remove', content: oldLine, oldLine: oldIdx + 1 });
        oldIdx++;
      } else if (nextNewMatch !== -1) {
        // 新内容有新增
        diff.push({ type: 'add', content: newLine, newLine: newIdx + 1 });
        newIdx++;
      } else {
        // 替换（删除旧行 + 新增新行）
        diff.push({ type: 'remove', content: oldLine, oldLine: oldIdx + 1 });
        diff.push({ type: 'add', content: newLine, newLine: newIdx + 1 });
        oldIdx++;
        newIdx++;
      }
    }
  }

  return diff;
}

// 格式化diff输出（unified diff风格，带行号和清晰分隔）
export function formatDiff(diff: DiffLine[], contextLines: number = 2): string {
  const output: string[] = [];

  // 找出所有变更块
  const blocks: { start: number; lines: DiffLine[] }[] = [];
  let currentBlock: DiffLine[] = [];
  let blockStart = 0;

  for (let i = 0; i < diff.length; i++) {
    const line = diff[i];

    if (line.type !== 'context') {
      // 变更行 - 开始新块或继续当前块
      if (currentBlock.length === 0) {
        // 块开始位置（往前找contextLines个context行）
        blockStart = Math.max(0, i - contextLines);
        // 添加前面的context行
        for (let j = blockStart; j < i; j++) {
          currentBlock.push(diff[j]);
        }
      }
      currentBlock.push(line);
    } else if (currentBlock.length > 0) {
      // 变更后的context - 添加作为块的结尾
      currentBlock.push(line);
      // 检查是否需要结束块
      const contextCount = currentBlock.filter(l => l.type === 'context').length;
      const changeCount = currentBlock.filter(l => l.type !== 'context').length;
      if (contextCount >= contextLines * 2 && changeCount > 0) {
        blocks.push({ start: blockStart, lines: [...currentBlock] });
        currentBlock = [];
      }
    }
  }

  // 处理最后一个块
  if (currentBlock.length > 0) {
    // 添加后面的context行
    blocks.push({ start: blockStart, lines: currentBlock });
  }

  // 如果没有变更块，但有diff内容（全部是上下文），直接返回空
  if (blocks.length === 0) {
    const changes = diff.filter(l => l.type !== 'context');
    if (changes.length === 0) return '';
  }

  // 输出每个块
  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];

    // 计算行号范围
    const oldLineNums = block.lines.filter(l => l.oldLine).map(l => l.oldLine!);
    const newLineNums = block.lines.filter(l => l.newLine).map(l => l.newLine!);

    const firstOldLine = oldLineNums[0] || 1;
    const firstNewLine = newLineNums[0] || 1;
    const oldCount = block.lines.filter(l => l.type !== 'add').length;
    const newCount = block.lines.filter(l => l.type !== 'remove').length;

    // 输出@@头（unified diff格式）
    output.push(DIFF_HEADER(`@@ -${firstOldLine},${oldCount} +${firstNewLine},${newCount} @@`));

    // 输出块内行
    for (const gLine of block.lines) {
      if (gLine.type === 'add') {
        output.push(DIFF_ADD(`+${gLine.newLine || ''}  ${gLine.content}`));
      } else if (gLine.type === 'remove') {
        output.push(DIFF_REMOVE(`-${gLine.oldLine || ''}  ${gLine.content}`));
      } else {
        output.push(DIFF_CONTEXT(`   ${gLine.content}`));
      }
    }

    // 块之间添加分隔（除了最后一个块）
    if (blockIdx < blocks.length - 1) {
      output.push(DIFF_CONTEXT('...'));
    }
  }

  return output.join('\n');
}

// 显示摘要diff（只显示变更统计）
export function formatDiffSummary(diff: DiffLine[]): string {
  const adds = diff.filter(d => d.type === 'add');
  const removes = diff.filter(d => d.type === 'remove');

  let summary = '';
  if (removes.length > 0) {
    summary += DIFF_REMOVE(`-${removes.length}`);
  }
  if (adds.length > 0) {
    if (summary) summary += ' ';
    summary += DIFF_ADD(`+${adds.length}`);
  }

  return summary || 'no changes';
}

// Generate diff from oldString/newString (for edit tool)
export function generateEditDiff(oldString: string, newString: string): string {
  const diff = computeDiff(oldString, newString);
  return formatDiff(diff, 1);
}
