import { TokenCounter } from '/home/zison/development/spica/spica-cli/src/llm/TokenCounter';
import fs from 'fs-extra';

const tc = new TokenCounter('gpt-4');
tc.setContextWindow(128000);

function tokens(text: string): number {
  return tc.estimateMessage({ role: 'user', content: text });
}
function k(t: number): string { return t >= 1000 ? `${(t/1000).toFixed(1)}k` : `${t}`; }

console.log('=== spica Token Consumption Analysis ===\n');

// 1. System Prompt
const sysText = fs.readFileSync('/home/zison/development/spica/spica-cli/src/prompts/system.ts', 'utf-8');
const sysMatch = sysText.match(/SYSTEM_PROMPT = `([^`]+)`/s);
const systemPrompt = sysMatch ? sysMatch[1] : '';
const sysTokens = tokens(systemPrompt);
console.log(`System Prompt (stable):          ${k(sysTokens)} tokens`);

// 2. Bootstrap skill
const bootstrapPath = '/home/zison/development/spica/spica-cli/src/builtin-skills/superpowers/using-superpowers/SKILL.md';
let bootstrapContent = '';
try {
  let raw = fs.readFileSync(bootstrapPath, 'utf-8');
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) raw = raw.slice(endIdx + 3).trim();
  }
  bootstrapContent = raw;
} catch {}
const bootstrapTokens = tokens(bootstrapContent);
console.log(`Bootstrap skill (using-superpowers): ${k(bootstrapTokens)} tokens`);

// 3. Variable skills
const skillsSection = '\n## Available Skills\n' + [
  'brainstorming', 'systematic-debugging', 'test-driven-development',
  'verification-before-completion', 'executing-plans', 'writing-plans',
  'dispatching-parallel-agents', 'subagent-driven-development',
  'requesting-code-review', 'receiving-code-review',
  'finishing-a-development-branch', 'using-git-worktrees',
  'writing-skills', 'using-superpowers',
].map(s => `- ${s}: Skill for ${s.replace(/-/g, ' ')}`).join('\n');
const skillsTokens = tokens(skillsSection);
console.log(`Skills metadata (variable):      ${k(skillsTokens)} tokens`);

// 4. Preamble total
const toolDefEstimate = 3500;
const preamble = sysTokens + bootstrapTokens + skillsTokens + toolDefEstimate;
const pct128 = ((preamble / 128000) * 100).toFixed(1);
const pct200 = ((preamble / 200000) * 100).toFixed(1);
console.log(`Tool definitions (estimated):     ~${k(toolDefEstimate)} tokens`);
console.log(`\n--- Context Budget ---`);
console.log(`Preamble total:                  ~${k(preamble)} tokens`);
console.log(`% of 128K window:                ${pct128}%`);
console.log(`% of 200K window:                ${pct200}%`);
console.log(`Available 128K for conversation:  ~${k(128000 - preamble)}`);
console.log(`Available 200K for conversation:  ~${k(200000 - preamble)}`);

// 5. Per-turn costs
const userMsg = tokens('Please fix the login bug - users cannot log in with correct credentials in src/auth/login.ts');
const toolCall = tokens('[Tools: read(path=src/auth/login.ts); grep(pattern=authenticate, path=src/auth/)] Let me investigate the login issue.');
const toolResult = tokens('File: src/auth/login.ts (156 lines)\nfunction authenticate(user, pass) { ... }\n...');
console.log(`\n--- Per-Turn Costs ---`);
console.log(`User message (typical):          ~${k(userMsg)} tokens`);
console.log(`Assistant + tool_calls prefix:   ~${k(toolCall)} tokens`);
console.log(`Tool result (500 chars):         ~${k(toolResult)} tokens`);
console.log(`1 turn (read file):              ~${k(userMsg + toolCall + toolResult)} tokens`);

// 6. Compression efficiency
console.log(`\n--- Compression ---`);
console.log(`Trigger threshold:               60% of window`);
console.log(`Target after compression:        40% of window`);
console.log(`Keep floor:                      10 messages`);
console.log(`Content truncation limit:        4000-6000 chars (per-role adaptive)`);
console.log(`Summary injection cost:          ~200-400 tokens (1 message)`);
const compressedTokens = 128000 * 0.4;
console.log(`Post-compression tokens:         ~${k(compressedTokens)} (at target)`);

// 7. Daily estimate
const turnsPerTask = 25;
const tasksPerDay = 10;
const daily = tasksPerDay * (preamble + turnsPerTask * (userMsg + toolCall + toolResult));
console.log(`\n--- Daily Usage (10 tasks, 25 turns each) ---`);
console.log(`Estimated daily tokens:          ~${k(daily)}`);
console.log(`Cache-hit savings (stable prefix): ~${k(sysTokens + bootstrapTokens)} tokens/request saved`);
