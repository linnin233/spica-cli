/**
 * Deep token analysis: measures ACTUAL system prompt size with project config
 * and calculates cumulative API costs for the current session.
 */
import fs from 'fs';
import { TokenCounter } from '../src/llm/TokenCounter';
import type { ChatMessage } from '../src/llm/providers/BaseProvider';

const tc = new TokenCounter('gpt-4o');
tc.setContextWindow(128000);

// ── 1. Measure actual system prompt ──────────────────────────────────────

// Load project config (CLAUDE.md / AGENTS.md)
const claudeMdPath = '/home/zison/development/spica/spica-cli/CLAUDE.md';
const parentClaudeMdPath = '/home/zison/development/spica/CLAUDE.md';
const claudeMdContent = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
const parentClaudeMdContent = fs.existsSync(parentClaudeMdPath) ? fs.readFileSync(parentClaudeMdPath, 'utf-8') : '';
const projectRawContent = claudeMdContent + '\n\n' + parentClaudeMdContent;

console.log('=== Project Config (CLAUDE.md) ===');
console.log(`spica-cli/CLAUDE.md: ${claudeMdContent.length.toLocaleString()} chars`);
console.log(`spica/CLAUDE.md:     ${parentClaudeMdContent.length.toLocaleString()} chars`);
console.log(`Combined:            ${projectRawContent.length.toLocaleString()} chars`);
const configTokens = tc.estimateTokens(projectRawContent);
console.log(`CLAUDE.md tokens:    ~${configTokens.toLocaleString()}`);

// System prompt core + bootstrap
const sysPromptCore = `You are spica, a coding agent CLI. You edit files, run commands, and help developers.
## Tool Usage
- Use read before editing files. Use glob to find files, grep to search content.
- Run independent tools in parallel. Conflicting tools (same file) are sequenced automatically.
- Use the task tool to dispatch sub-agents for isolated sub-tasks.
- Prefer file-scoped commands over project-wide.

## Tool Batching (Save Context Window)
- Plan your reads BEFORE making any calls. Batch all independent reads together.
- Batch all independent writes together similarly.

## Safety
- Ask before: rm -rf, sudo, git push --force, git reset --hard.

## Error Recovery
- When a tool fails: analyze the error, try an alternative approach.

## Output Format
- Use markdown for structure. Code blocks with language tags. File references as \`path:line\`.
- Be concise. No fluff.

## Completion
- Never claim completion without running verification (tests, lint, build).
- Continue working until the task is done or the user explicitly stops you.`;

const bootstrapSkill = fs.readFileSync(
  '/home/zison/development/spica/spica-cli/src/builtin-skills/superpowers/using-superpowers/SKILL.md',
  'utf-8'
);
let bootstrapBody = bootstrapSkill;
if (bootstrapBody.startsWith('---')) {
  const endIdx = bootstrapBody.indexOf('---', 3);
  if (endIdx !== -1) bootstrapBody = bootstrapBody.slice(endIdx + 3).trim();
}

const fileScopedSection = `
## File-Scoped Commands (Preferred - Fast)
Always prefer file-scoped commands over project-wide. Token savings: 97%.
| Operation | File-Scoped (Fast) | Project-Wide (Slow) |
|-----------|-------------------|--------------------|
| Type check | npx tsc --noEmit <file> (3s) | npm run typecheck (2min) |
| Lint | npx eslint <file> (1s) | npm run lint (30s) |
| Test | npm run test -- <file> (2s) | npm run test (4min) |
**Project-Wide Commands (Ask First)**: npm run build, Full test suite`;

const stablePromptParts = [
  sysPromptCore,
  '\n\n## How to Use Skills\n' + bootstrapBody,
  fileScopedSection,
  '\n\n## Project Guidelines (from CLAUDE.md) - Highest Priority\n' + projectRawContent,
];
const stablePrompt = stablePromptParts.join('\n');
const stableTokens = tc.estimateTokens(stablePrompt);

console.log('\n=== System Prompt Breakdown ===');
console.log(`Core identity + rules:  ${tc.estimateTokens(sysPromptCore).toLocaleString().padStart(5)} tokens`);
console.log(`Bootstrap skill:        ${tc.estimateTokens(bootstrapBody).toLocaleString().padStart(5)} tokens`);
console.log(`File-scoped commands:   ${tc.estimateTokens(fileScopedSection).toLocaleString().padStart(5)} tokens`);
console.log(`CLAUDE.md content:      ${configTokens.toLocaleString().padStart(5)} tokens`);
console.log(`STABLE TOTAL:           ${stableTokens.toLocaleString().padStart(5)} tokens`);

// ── 2. Skills metadata ──────────────────────────────────────────────────
const skillsDir = '/home/zison/development/spica/spica-cli/src/builtin-skills/superpowers';
const skillNames = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.'));
const skillsMeta = skillNames.map(n => `- ${n}: ...`).join('\n');
const variableTokens = tc.estimateTokens(skillsMeta);
console.log(`\nSkills metadata (${skillNames.length} skills): ${variableTokens} tokens`);

// ── 3. Tool definitions ─────────────────────────────────────────────────
// Read tool registry and simulate API format
import { TOOLS_DEFINITIONS } from '../src/tools/registry';
const apiToolsJson = JSON.stringify(TOOLS_DEFINITIONS.map((t: any) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
})));
const toolTokens = tc.estimateTokens(apiToolsJson);
console.log(`\nTool definitions (${TOOLS_DEFINITIONS.length} tools, API format):`);
console.log(`  JSON: ${apiToolsJson.length.toLocaleString()} chars`);
console.log(`  Tokens: ${toolTokens.toLocaleString()}`);

// ── 4. TOTAL PREAMBLE ───────────────────────────────────────────────────
const totalPreamble = stableTokens + variableTokens + toolTokens;
console.log(`\n=== ACTUAL TOTAL PREAMBLE ===`);
console.log(`System (stable):   ${stableTokens.toLocaleString().padStart(6)} tokens`);
console.log(`Skills metadata:   ${variableTokens.toLocaleString().padStart(6)} tokens`);
console.log(`Tool definitions:  ${toolTokens.toLocaleString().padStart(6)} tokens`);
console.log(`TOTAL PREAMBLE:    ${totalPreamble.toLocaleString().padStart(6)} tokens`);
console.log(`% of 128K: ${(totalPreamble / 128000 * 100).toFixed(1)}%`);
console.log(`% of  64K: ${(totalPreamble / 64000 * 100).toFixed(1)}%`);

// ── 5. Analyze actual session ───────────────────────────────────────────
const session = JSON.parse(
  fs.readFileSync('/home/zison/development/spica/spica-cli/.spica/session.json', 'utf-8')
);
const msgs: ChatMessage[] = session.messages || [];

console.log(`\n=== Current Session ===`);
console.log(`Total messages: ${msgs.length}`);

let sessionTokens = 0;
for (const m of msgs) {
  sessionTokens += tc.estimateMessage(m);
}
console.log(`Session message tokens: ${sessionTokens.toLocaleString()}`);

// ── 6. Cumulative API costs ────────────────────────────────────────────
// Each user turn sends: preamble + all messages up to that point
// We simulate "first request sends preamble + first user msg"
// "2nd request sends preamble + all msgs up to 2nd user msg"

// Find user message indices
const userIndices: number[] = [];
msgs.forEach((m, i) => {
  if (m.role === 'user') userIndices.push(i);
});

console.log(`\n=== Cumulative API Cost ===`);
console.log(`User turns: ${userIndices.length}`);

let cumulativeInput = 0;
const requestSizes: number[] = [];

for (let t = 0; t < userIndices.length; t++) {
  const upToIdx = userIndices[t];
  // This request sends: preamble + messages[0..upToIdx]
  let msgTokensUpToHere = 0;
  for (let i = 0; i <= upToIdx; i++) {
    msgTokensUpToHere += tc.estimateMessage(msgs[i]);
  }
  const thisRequest = totalPreamble + msgTokensUpToHere;
  cumulativeInput += thisRequest;
  requestSizes.push(thisRequest);
}

console.log(`Requests: ${requestSizes.length}`);
console.log(`First request: ${requestSizes[0]?.toLocaleString() || 'N/A'} tokens`);
console.log(`Last request:  ${requestSizes[requestSizes.length - 1]?.toLocaleString() || 'N/A'} tokens`);
console.log(`Avg request:   ${Math.round(cumulativeInput / requestSizes.length).toLocaleString()} tokens`);
console.log(`Cumulative input: ${cumulativeInput.toLocaleString()} tokens`);

// Estimate output (rough: 300 tokens per assistant response + tool_calls overhead)
// Each user turn = 1 assistant(tools) + N tool results + 1 final assistant
// ~400-800 output tokens per turn
const avgOutputPerTurn = 500;
const totalOutput = userIndices.length * avgOutputPerTurn;
console.log(`Est. output: ${totalOutput.toLocaleString()} tokens (${avgOutputPerTurn}/turn)`);

// ── 7. Cost at DeepSeek pricing ─────────────────────────────────────────
// DeepSeek pricing (as of 2025):
// deepseek-chat (v3): ¥1/M input, ¥2/M output
// deepseek-reasoner (r1): ¥4/M input, ¥16/M output
// Cache hit: 50% discount on input

// Check which model from config
let modelName = 'deepseek-chat'; // default
try {
  const configRaw = fs.readFileSync(process.env.HOME + '/.spica/config.json', 'utf-8');
  const config = JSON.parse(configRaw);
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'object' && v !== null && 'model' in v) {
      modelName = (v as any).model || modelName;
      break;
    }
  }
} catch {}

const isReasoner = modelName.includes('reasoner') || modelName.includes('r1');
const inputPrice = isReasoner ? 4.0 : 1.0;   // ¥ per 1M tokens
const outputPrice = isReasoner ? 16.0 : 2.0;  // ¥ per 1M tokens

console.log(`\n=== Cost Estimate (${modelName}) ===`);
console.log(`Pricing: ¥${inputPrice}/M input, ¥${outputPrice}/M output`);

const inputCost = cumulativeInput / 1_000_000 * inputPrice;
const outputCost = totalOutput / 1_000_000 * outputPrice;
const totalCost = inputCost + outputCost;

console.log(`Input:  ${cumulativeInput.toLocaleString()} tokens → ¥${inputCost.toFixed(3)}`);
console.log(`Output: ${totalOutput.toLocaleString()} tokens → ¥${outputCost.toFixed(3)}`);
console.log(`TOTAL:  ¥${totalCost.toFixed(3)}`);

// But wait — each user turn may trigger MULTIPLE LLM API calls
// (assistant with tools → continue with results → more tools → final response)
// The tool loop multiplies cost significantly
// Let's count actual tool_call patterns
let apiCallsEstimate = 0;
for (const m of msgs) {
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    apiCallsEstimate++;
  } else if (m.role === 'assistant' && m.content && !m.toolCalls) {
    apiCallsEstimate++; // final text response
  }
}
console.log(`\nEstimated LLM API calls in this session: ${apiCallsEstimate}`);

// More realistic: each API call after the first in a turn sends
// preamble + all prior messages + new tool results
// This is MUCH more expensive than the simple per-turn model

// Let's do a more accurate cumulative model:
// Walk through messages sequentially, count each assistant message as an API call
cumulativeInput = 0;
let runningMsgTokens = 0;
let llmCalls = 0;
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  runningMsgTokens += tc.estimateMessage(m);

  if (m.role === 'assistant') {
    // This assistant response was an API call
    // It sent: preamble + messages[0..i-1]
    const inputForThisCall = totalPreamble + (runningMsgTokens - tc.estimateMessage(m));
    cumulativeInput += inputForThisCall;
    llmCalls++;
  }
}

console.log(`\n=== More Accurate: Per-LLM-Call Model ===`);
console.log(`LLM calls: ${llmCalls}`);
const accurateInput = cumulativeInput;
console.log(`Cumulative input: ${accurateInput.toLocaleString()} tokens`);

// Estimate output per call
const totalOutputAccurate = llmCalls * 400; // ~400 output tokens per call
console.log(`Est. output: ${totalOutputAccurate.toLocaleString()} tokens`);

const accurateInputCost = accurateInput / 1_000_000 * inputPrice;
const accurateOutputCost = totalOutputAccurate / 1_000_000 * outputPrice;
const accurateTotal = accurateInputCost + accurateOutputCost;

console.log(`\n=== Accurate Cost (${modelName}) ===`);
console.log(`Input cost:  ¥${accurateInputCost.toFixed(3)}`);
console.log(`Output cost: ¥${accurateOutputCost.toFixed(3)}`);
console.log(`THIS SESSION: ¥${accurateTotal.toFixed(3)}`);

// ── 8. Why ¥10+/day? ───────────────────────────────────────────────────
console.log(`\n=== Why ¥10+/Day? ===`);
console.log(`One session like this: ¥${accurateTotal.toFixed(2)}`);
console.log(`If ${modelName.includes('r1') ? 'using R1' : 'using V3'}:`);
if (!isReasoner) {
  console.log(`  As V3 this is ¥${accurateTotal.toFixed(2)}`);
  console.log(`  But if you were on R1 (¥4/¥16): ¥${(accurateInput/1e6*4 + totalOutputAccurate/1e6*16).toFixed(2)}`);
}

// Multiple sessions per day
const sessionsToday = 3; // estimate
console.log(`\nWith ~${sessionsToday} similar sessions today:`);
console.log(`  Total: ¥${(accurateTotal * sessionsToday).toFixed(2)}`);

// The real killer: each tool loop iteration sends the ENTIRE history
// A single user request with 5 tool calls = 5+ API calls, each sending all prior messages
console.log(`\n=== The Real Problem ===`);
console.log(`Each tool loop iteration sends FULL preamble + FULL history.`);
console.log(`Session has ${llmCalls} LLM calls for ${userIndices.length} user turns.`);
console.log(`That's ${(llmCalls / userIndices.length).toFixed(1)} calls per user turn.`);
console.log(`Each call after mid-session sends ${totalPreamble.toLocaleString()} + history tokens.`);
