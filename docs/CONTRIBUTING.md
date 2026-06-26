# Contributing to Spica

## Development Setup

```bash
git clone https://github.com/your-repo/spica-cli
cd spica-cli
npm install
npm run build
npm run test
```

## Project Structure

```
spica-cli/
├── src/
│   ├── agent.ts              # Core agent orchestrator
│   ├── index.ts              # CLI entry point (commander)
│   ├── llm/                  # LLM client + providers
│   │   ├── LLMClient.ts      # Streaming client with rate limiter
│   │   ├── TokenCounter.ts   # tiktoken token estimation
│   │   ├── RateLimiter.ts    # Request/token rate limiting
│   │   └── providers/        # OpenAI-compatible adapters
│   ├── core/                 # Core modules
│   │   ├── init.ts           # Agent initialization
│   │   ├── AgentState.ts     # Unified state machine
│   │   ├── progressTracker.ts # Structured progress tracking
│   │   ├── compression.ts    # Context compression (2-phase)
│   │   ├── learnings.ts      # Auto-learning extraction
│   │   ├── RuntimeState.ts   # Singleton session state
│   │   ├── EventBus.ts       # Pub/sub event bus
│   │   └── ProcessMonitor.ts # PID tracking + kill
│   ├── tools/                # Tool definitions + execution
│   │   ├── registry.ts       # 33 tool definitions
│   │   ├── execute.ts        # Tool dispatch + cache
│   │   ├── subAgent.ts       # Sub-agent configs
│   │   ├── analytics.ts      # Tool usage tracking
│   │   ├── cache.ts          # Tool result cache (30s TTL)
│   │   ├── sandbox.ts        # bwrap sandbox wrapper
│   │   └── impl/             # Tool implementations
│   ├── cli/                  # TUI + event handlers
│   │   ├── events.ts         # Agent event → TUI display
│   │   ├── formatting.ts     # Output formatting
│   │   ├── results.ts        # Tool result tracking
│   │   ├── subagentPanel.ts  # Sub-agent progress display
│   │   └── ui/               # Terminal UI components
│   ├── commands/             # CLI command handlers
│   │   ├── interactive.ts    # TUI mode
│   │   ├── simpleMode.ts     # Readline mode
│   │   ├── providers.ts      # Provider management CLI
│   │   └── slash/            # Slash command handlers
│   ├── prompts/              # System prompts
│   │   └── system.ts         # getSystemPromptStable/Variable
│   ├── skills/               # Skill loader + executor
│   ├── builtin-skills/       # 14 built-in skills
│   ├── hooks/                # PreToolUse/PostToolUse hooks
│   ├── mcp/                  # MCP client (modelcontextprotocol)
│   ├── storage/              # Persistence (checkpoints, state, tasks)
│   ├── utils/                # Utilities (session, settings, config)
│   └── __tests__/            # Tests (mirrors src structure)
├── docs/                     # Documentation
│   ├── MANUAL.md             # User manual
│   ├── CONTRIBUTING.md       # This file
│   └── superpowers/          # Skill specs + design docs
├── bin/                      # Compiled executable
├── scripts/                  # Build + test scripts
└── package.json
```

## Code Standards

### TypeScript
- Strict mode enabled
- No `any` types without justification
- Clear interfaces for data structures

### Error Handling
- Follow [ERROR_HANDLING.md](ERROR_HANDLING.md)
- Always return actionable error messages
- Preserve context on failure

### Comments
- Prefer English for AI-readable content
- Comments for complex logic
- No redundant comments

## Pull Request Process

### Before Submitting

1. **Run tests**: `npm run test:run`
2. **Build**: `npm run build`
3. **Type check**: `npx tsc --noEmit`
4. **Self-review**: Review your own changes first

### PR Requirements

- **Description**: Clear explanation of changes
- **Tests**: New features must have tests
- **Documentation**: Update docs if needed
- **One PR, one purpose**: Don't mix unrelated changes

### Review Checklist

Reviewers should check:

#### Code Quality
- [ ] No TypeScript errors
- [ ] No `any` types without justification
- [ ] Proper error handling
- [ ] No memory leaks

#### Architecture
- [ ] Follows existing patterns
- [ ] No unnecessary coupling
- [ ] Clear separation of concerns

#### Security
- [ ] No new shell injection risks
- [ ] Proper permission checks
- [ ] No sensitive data exposure

#### Testing
- [ ] Unit tests for new logic
- [ ] Edge cases covered
- [ ] No flaky tests

#### Documentation
- [ ] MANUAL.md updated if user-facing
- [ ] README.md + CLAUDE.md updated if structural
- [ ] Comments for complex code

## Testing Guidelines

### Unit Tests
- Test individual functions
- Mock external dependencies
- Clear test names

### Integration Tests
- Test component interactions
- Use real implementations where possible
- Clean up after tests

### Security Tests
- Test injection patterns
- Test permission system
- Test bypass mode

## Tool Development

### Adding a New Tool

1. Add definition in `src/tools/registry.ts` (`TOOLS_DEFINITIONS` array):
```typescript
{
  name: 'my_tool',
  description: 'Clear description for AI',
  parameters: {
    type: 'object',
    properties: {
      param: { type: 'string', description: 'Param description' }
    },
    required: ['param']
  }
}
```

2. Add implementation in `executeTool()`:
```typescript
case 'my_tool': {
  const param = safeArgs.param;
  // Implementation
  return { success: true, output: 'result' };
}
```

3. Add tests in `src/__tests__/`

4. Update MANUAL.md

### Tool Guidelines

- **Always return `{ success: boolean, error?: string }`**
- **Clear error messages with suggestions**
- **Validate parameters**
- **Handle edge cases**
- **Don't mutate global state**

## Event Development

### Adding a New Event

1. Define in agent.ts:
```typescript
this.emit('my_event', { data });
```

2. Handle in cli/events.ts (or formatting.ts / results.ts / subagentPanel.ts):
```typescript
on('my_event', (data) => {
  screen.appendScroll(...);
});
```

3. Document in README.md and CLAUDE.md

## Release Process

1. Update version in package.json
2. Update CHANGELOG.md
3. Run full test suite
4. Create git tag
5. Publish to npm

## Questions?

- Check MANUAL.md for usage
- Check README.md + CLAUDE.md for design
- Check ERROR_HANDLING.md for error patterns
- Open an issue for bugs
- Discuss major changes before implementing