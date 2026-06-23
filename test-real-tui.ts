#!/usr/bin/env tsx
/**
 * 真实TUI交互测试 - 模拟用户操作
 */

import * as pty from 'node-pty';
import * as fs from 'fs';

const TEST_PROMPT = 'hello world';

async function testTUI() {
  return new Promise<void>((resolve, reject) => {
    console.log('\n=== 启动 TUI ===\n');

    const ptyProcess = pty.spawn('npm', ['run', 'dev'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>
    });

    let output = '';
    let phase: 'init' | 'connected' | 'input' | 'streaming' | 'done' = 'init';
    const startTime = Date.now();

    ptyProcess.onData((data) => {
      output += data;
      process.stdout.write(data);  // 实时显示输出

      // 检测连接成功
      if (phase === 'init' && output.includes('[OK] Connected')) {
        phase = 'connected';
        console.log('\n>>> [检测到连接成功，开始输入测试]');

        // 等待一下让TUI稳定
        setTimeout(() => {
          console.log('\n>>> [输入: ' + TEST_PROMPT + ']');
          ptyProcess.write(TEST_PROMPT);

          setTimeout(() => {
            console.log('\n>>> [按Enter发送]');
            ptyProcess.write('\r');
            phase = 'input';
          }, 500);
        }, 1000);
      }

      // 检测流式输出开始
      if (phase === 'input' && (output.includes('assistant') || output.includes('思考'))) {
        phase = 'streaming';
        console.log('\n>>> [检测到流式输出开始]');
      }

      // 流式输出中测试resize
      if (phase === 'streaming') {
        const elapsed = Date.now() - startTime;
        if (elapsed > 5000 && elapsed < 5500) {
          console.log('\n>>> [测试RESIZE: 80x24 -> 120x30]');
          ptyProcess.resize(120, 30);
        }
        if (elapsed > 6000 && elapsed < 6500) {
          console.log('\n>>> [测试RESIZE: 120x30 -> 80x24]');
          ptyProcess.resize(80, 24);
        }
      }

      // 超时或完成检测
      if (Date.now() - startTime > 30000) {
        console.log('\n>>> [测试超时，退出]');
        ptyProcess.write('\x03');  // Ctrl+C
        setTimeout(() => {
          ptyProcess.kill();
          resolve();
        }, 500);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log('\n=== 测试结束 ===');
      console.log('Exit code:', exitCode);

      // 保存完整输出用于分析
      fs.writeFileSync('/tmp/tui-test-output.log', output);
      console.log('\n完整输出已保存到 /tmp/tui-test-output.log');

      resolve();
    });
  });
}

testTUI().catch(console.error);