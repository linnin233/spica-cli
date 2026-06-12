const TIER_1_SIMPLE_PATTERNS = ['how to improve', 'could we', 'should we', 'what would you change'];

const TIER_1_COMPOSITE_PATTERNS: Array<[string, string]> = [['how to make', 'better']];

const TIER_2_VERBS = ['create', 'add', 'build', 'make', 'implement', 'write'];
const TIER_2_NOUNS = [
  'feature',
  'component',
  'module',
  'system',
  'function',
  'class',
  'file',
  'something',
  'thing',
];

const TIER_3_KEYWORDS = [
  'fix',
  'debug',
  'bug',
  'error',
  'broken',
  'not working',
  'failing',
  'crash',
  'test fail',
  'tests fail',
];

const TIER_4_PATTERNS = ['review', 'check my code', 'look over'];

const TIER_5_ALWAYS_NULL_PREFIXES = ['what is', 'how does'];
const TIER_5_CONDITIONAL_NULL_PREFIXES = ['explain'];

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
  // Checked before Tier 2 so that "what is a build system" isn't caught as creation
  if (TIER_5_ALWAYS_NULL_PREFIXES.some(p => lower.startsWith(p))) {
    return null;
  }

  const hasCreationOrFix = [...TIER_2_VERBS, ...TIER_3_KEYWORDS].some(k => lower.includes(k));
  if (TIER_5_CONDITIONAL_NULL_PREFIXES.some(p => lower.startsWith(p)) && !hasCreationOrFix) {
    return null;
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
