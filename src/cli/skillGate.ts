// Skill auto-suggestion — classifies user intent and maps to matching skills.
// Integrated into runLoop to nudge the LLM toward relevant skills.

// ── Tier 1: Design / brainstorming ──────────────────────────────────────

const TIER_1_SIMPLE_PATTERNS = ['how to improve', 'could we', 'should we', 'what would you change'];
const TIER_1_COMPOSITE_PATTERNS: Array<[string, string]> = [['how to make', 'better']];

// ── Tier 2: Creation / building ──────────────────────────────────────────

const TIER_2_VERBS = ['create', 'add', 'build', 'make', 'implement', 'write'];
const TIER_2_NOUNS = [
  'feature', 'component', 'module', 'system', 'function',
  'class', 'file', 'something', 'thing',
];

// ── Tier 3: Debugging ────────────────────────────────────────────────────

const TIER_3_KEYWORDS = [
  'fix', 'debug', 'bug', 'error', 'broken',
  'not working', 'failing', 'crash', 'test fail', 'tests fail',
];

// ── Tier 4: Code review ──────────────────────────────────────────────────

const TIER_4_PATTERNS = ['review', 'check my code', 'look over'];

// ── Tier 5: Negative patterns (pure info questions — no skill) ──────────

const TIER_5_ALWAYS_NULL_PREFIXES = ['what is', 'how does'];
const TIER_5_CONDITIONAL_NULL_PREFIXES = ['explain'];

// ── Tier 6: TDD / testing ────────────────────────────────────────────────

const TIER_6_PATTERNS = [
  'test first', 'test-driven', 'tdd', 'write tests for',
  'add tests', 'add test', 'write test', 'test coverage',
];

// ── Tier 7: Plan execution ───────────────────────────────────────────────

const TIER_7_PATTERNS = [
  'execute plan', 'follow plan', 'implement plan',
  'execute the plan', 'follow the plan',
];

// ── Tier 8: Verification ─────────────────────────────────────────────────

const TIER_8_PATTERNS = [
  'verify', 'check my work', 'check work', 'validate',
  'make sure everything', 'double check',
];

// ── Tier 9: Branch finishing ─────────────────────────────────────────────

const TIER_9_PATTERNS = [
  'finish branch', 'finish the branch', 'merge to',
  'ready to merge', 'pr ready', 'pull request',
  'clean up branch', 'wrap up',
];

// ── Tier 10: Git worktrees ───────────────────────────────────────────────

const TIER_10_PATTERNS = [
  'worktree', 'work tree', 'isolated branch',
  'separate branch', 'parallel work',
];

export function classifyIntent(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower) return null;

  // Tier 1 — explicit design/improvement questions
  if (
    TIER_1_SIMPLE_PATTERNS.some(p => lower.includes(p)) ||
    TIER_1_COMPOSITE_PATTERNS.some(([a, b]) => lower.includes(a) && lower.includes(b))
  ) {
    return 'brainstorming';
  }

  // Tier 5 — negative patterns (pure info questions)
  // Checked before Tier 2 so "what is a build system" isn't caught as creation
  if (TIER_5_ALWAYS_NULL_PREFIXES.some(p => lower.startsWith(p))) {
    return null;
  }

  const hasCreationOrFix = [...TIER_2_VERBS, ...TIER_3_KEYWORDS].some(k => lower.includes(k));
  if (TIER_5_CONDITIONAL_NULL_PREFIXES.some(p => lower.startsWith(p)) && !hasCreationOrFix) {
    return null;
  }

  // Tier 6 — TDD / testing (check before Tier 2 to catch "write tests for X")
  if (TIER_6_PATTERNS.some(p => lower.includes(p))) {
    return 'test-driven-development';
  }

  // Tier 7 — Plan execution
  if (TIER_7_PATTERNS.some(p => lower.includes(p))) {
    return 'executing-plans';
  }

  // Tier 8 — Verification
  if (TIER_8_PATTERNS.some(p => lower.includes(p))) {
    return 'verification-before-completion';
  }

  // Tier 9 — Branch finishing
  if (TIER_9_PATTERNS.some(p => lower.includes(p))) {
    return 'finishing-a-development-branch';
  }

  // Tier 10 — Git worktrees
  if (TIER_10_PATTERNS.some(p => lower.includes(p))) {
    return 'using-git-worktrees';
  }

  // Tier 2 — creation keywords + target noun
  const hasCreationVerb = TIER_2_VERBS.some(v => lower.includes(v));
  const hasTargetNoun = TIER_2_NOUNS.some(n => lower.includes(n));
  if (hasCreationVerb && hasTargetNoun) {
    return 'brainstorming';
  }

  // Tier 3 — bug/fix keywords
  if (TIER_3_KEYWORDS.some(k => lower.includes(k))) {
    return 'systematic-debugging';
  }

  // Tier 4 — review keywords
  if (TIER_4_PATTERNS.some(p => lower.includes(p))) {
    return 'requesting-code-review';
  }

  return null;
}
