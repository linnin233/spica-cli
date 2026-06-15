---
name: frontend-design
description: Frontend UI iteration workflow — design system, component patterns, Playwright verification
---

<EXTREMELY-IMPORTANT>
When working on frontend UI changes, you MUST follow this workflow.
If a skill applies to your task, you do not have a choice. You must use it.
</EXTREMELY-IMPORTANT>

## Frontend Design Workflow

### 1. Understand the Design System FIRST

Before writing any code, read the existing frontend files to understand:
- The component structure and hierarchy
- The CSS/design token system (colors, spacing, typography)
- The existing patterns and conventions

```bash
# Always start with exploration
glob(pattern="static/**/*.{html,css,js,ts,tsx}")
glob(pattern="src/**/*.{css,scss,less}")
```

### 2. Plan Component Changes

Use `/executing-plans` to structure your implementation:
- Break down the UI change into discrete, verifiable steps
- Each step should produce a visible, testable result
- Write the plan BEFORE writing code

### 3. Implement Incrementally

- Make ONE change at a time, verify it works, then move on
- Never batch unrelated UI changes in a single edit
- Use the existing design system — don't invent new patterns

### 4. Verify with Playwright

After each change, use `/verification-before-completion` workflow:
- Navigate to the changed page
- Take a snapshot to verify the UI renders correctly
- Click through the affected flows
- Check responsive behavior at different viewport sizes

```bash
# Use Playwright MCP tools for verification:
# playwright_browser_navigate → playwright_browser_snapshot → playwright_browser_click
```

### 5. Clean Up

- Remove unused CSS classes and dead code
- Ensure no console errors
- Verify the change works in both light and dark modes (if applicable)

## When to Use This Skill

Use this skill for ANY frontend task involving:
- Adding, modifying, or removing UI components
- CSS/styling changes
- HTML structure changes
- Client-side JavaScript behavior
- Design system iteration
- Responsive layout changes
- Accessibility improvements

## Skill Combinations

Common combinations for frontend work:
- `/test-driven-development` + `/frontend-design` — when writing new UI components with tests
- `/frontend-design` — standalone for pure styling/HTML changes
- `/systematic-debugging` + `/frontend-design` — when fixing frontend bugs
