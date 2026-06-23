// 测试 ESC ESC 是否真的停止执行
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

const logFile = fs.createWriteStream('/tmp/interrupt-real-test-log.txt', { flags: 'w' });

function log(msg) {
  const timestamp = new Date().toISOString();
  logFile.write(`${timestamp}: ${msg}\n`);
  console.log(msg);
}

async function test() {
  log('=== Testing if ESC ESC really stops execution ===');

  // 直接运行 spica-cli 源码
  const spicaDir = process.cwd();
  const spica = pty.spawn('tsx', [
    '--tsconfig', 
    path.join(spicaDir, 'tsconfig.json'),
    path.join(spicaDir, 'src/index.ts'),
    'run'
  ], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME + '/development/playground',
    env: { ...process.env, HOME: process.env.HOME }
  });

  let output = '';

  spica.onData((data) => {
    output += data;
    process.stdout.write(data);
  });

  // 等待启动
  log('Waiting 5s for spica to start...');
  await new Promise(r => setTimeout(r, 5000));

  // 发送任务
  log('\nSending: "sleep 30 and then tell me done"');
  spica.write('sleep 30 and then tell me done\r');

  // 等待任务开始
  log('Waiting 5s for task to start...');
  await new Promise(r => setTimeout(r, 5000));

  // 发送 ESC ESC
  log('\nSending ESC ESC...');
  spica.write('\x1b');
  await new Promise(r => setTimeout(r, 100));
  spica.write('\x1b');

  // 等待中断生效
  log('Waiting 5s for interrupt to take effect...');
  await new Promise(r => setTimeout(r, 5000));

  // 发送新命令
  log('\nSending new command: "what is 2+2"');
  spica.write('what is 2+2\r');

  // 等待响应
  await new Promise(r => setTimeout(r, 8000));

  // 分析
  log('\n\n=== Analysis ===');
  
  const interruptedCount = (output.match(/INTERRUPTED/gi) || []).length;
  log(`INTERRUPTED mentions: ${interruptedCount}`);

  const stoppedCount = (output.match(/stopped/gi) || []).length;
  log(`"stopped" mentions: ${stoppedCount}`);

  if (output.includes('4') || output.includes('four')) {
    log('✓ New command (2+2) was processed');
  } else {
    log('✗ New command may not have been processed');
  }

  // 检查是否有 sleep 进程还在运行
  log('\nChecking for sleep processes...');
  const { execSync } = require('child_process');
  try {
    const psOutput = execSync('ps aux | grep "sleep 30" | grep -v grep').toString();
    log('Sleep 30 processes still running:\n' + psOutput);
  } catch {
    log('✓ No sleep 30 processes running');
  }

  fs.writeFileSync('/tmp/interrupt-real-output.txt', output);
  log('\nFull output saved to /tmp/interrupt-real-output.txt');

  spica.kill();
  logFile.close();
}

test().catch(e => {
  console.error(e);
  logFile.close();
});
