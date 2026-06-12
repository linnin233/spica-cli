import { parseRuleLayers } from '../projectConfig';

describe('parseRuleLayers', () => {
  test('parses CRITICAL rules', () => {
    const content = `
## [CRITICAL] Security Rules
- Never commit secrets
- Validate all inputs
`;
    const result = parseRuleLayers(content);
    expect(result.critical).toContain('Never commit secrets');
    expect(result.critical).toContain('Validate all inputs');
  });

  test('parses IMPORTANT rules', () => {
    const content = `
## [IMPORTANT] Code Quality
- Test coverage minimum 80%
- Components under 200 lines
`;
    const result = parseRuleLayers(content);
    expect(result.important).toContain('Test coverage minimum 80%');
  });

  test('parses PREF preferences', () => {
    const content = `
## [PREF] Style Preferences
- Use named exports
- Arrow functions for React
`;
    const result = parseRuleLayers(content);
    expect(result.preferences).toContain('Use named exports');
  });

  test('handles mixed content', () => {
    const content = `
# Project Overview
Some description here.

## [CRITICAL] Security
- Rule 1

## Regular Section
Normal content.

## [IMPORTANT] Quality
- Rule 2

## [PREF] Style
- Preference 1
`;
    const result = parseRuleLayers(content);
    expect(result.critical.length).toBe(1);
    expect(result.important.length).toBe(1);
    expect(result.preferences.length).toBe(1);
  });

  test('returns empty arrays for no tags', () => {
    const content = `
# Project
No tagged sections.
`;
    const result = parseRuleLayers(content);
    expect(result.critical).toEqual([]);
    expect(result.important).toEqual([]);
    expect(result.preferences).toEqual([]);
  });
});
