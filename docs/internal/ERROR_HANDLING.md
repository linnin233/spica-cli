# Error Handling Strategy

## Overview

This document defines the unified error handling strategy for spica-cli.

## Error Categories

### 1. Tool Execution Errors
- **Transient**: Network issues, timeout, rate limiting → Retry
- **Permanent**: File not found, invalid arguments → Return error, AI adjusts
- **Critical**: Authentication failure, permission denied → Stop, user intervention

### 2. LLM API Errors  
- **Retryable**: Timeout, rate limit, network error → Retry with backoff (max 10)
- **Non-retryable**: 401, 403, invalid request → Stop, user intervention
- **On failure**: Preserve tool results, add system message for user to continue

### 3. Agent State Errors
- **Context overflow**: Auto-compress, emit warning
- **Interrupt**: Save state, emit event, clean abort
- **Critical tool failure**: Stop loop, return error with suggestion

## Unified Patterns

### Tool Error Response
```typescript
interface ToolResult {
  success: boolean;
  error?: string;      // Always include clear error message
  output?: string;
  suggestion?: string; // Optional: how to fix or retry
}
```

### Agent Error Handling
```typescript
// Good: Preserve context
try {
  result = await llm.continueWithToolResults(toolResults);
} catch (error) {
  // Add system message so user can continue
  llm.addMessage({ role: 'user', content: `[SYSTEM] Previous work preserved. Error: ${errorMsg}` });
  return `Operations preserved. Error: ${errorMsg}`;
}

// Bad: Lose context (old pattern)
catch (error) {
  llm.setMessages([]); // DON'T DO THIS
}
```

### Error Messages Format
- **Clear**: What went wrong
- **Actionable**: What to do next
- **Context**: Relevant details (file path, command, etc.)

Example:
```
Good: "File not found: /src/main.ts. Read the file first to verify path."
Bad: "error"
```

## Current Issues (Fixed Today)

| Issue | Location | Fix |
|-------|----------|-----|
| LLM continue failure drops tool results | agent.ts | Preserve results, add system message |
| Tool execution error drops context | agent.ts | Return error with preserved state |
| Session truncation drops summary | session.ts | Don't truncate summary messages |
| Sub-agent timeout doesn't interrupt | tools/index.ts | Call taskAgent.interrupt() |

## Guidelines

1. **Never silently discard user work** - Always preserve or clearly communicate
2. **Always provide actionable suggestions** - Not just "error occurred"
3. **Use consistent error types** - ToolError, LLMError, AgentError
4. **Log for debugging** - Use emit('error_suggestion') for visibility
5. **Handle interrupts gracefully** - Save state before stopping

## Checklist for New Code

- [ ] Error returned to AI is clear and actionable
- [ ] Context preserved on failure (tool results, messages)
- [ ] Retry logic for transient errors
- [ ] Suggestion provided for user intervention cases
- [ ] Interrupt handling preserves state