# Spica TUI Improvements Design

**Date**: 2026-05-12
**Status**: Draft
**Plan**: docs/superpowers/plans/2026-05-12-tui-improvements.md

---

## Summary

Two critical improvements for Spica's TUI:
1. Fix input loss during fast typing (diagnose ink-text-input configuration)
2. Add split-screen layout with focus-linked panels and marquee scrolling

---

## Problem 1: Input Loss During Fast Typing

### Symptoms

- Single characters randomly disappear
- Input lags then loses partial content
- Occurs both during LLM output and idle state

### Root Cause Analysis

Current architecture:
```
TextInput (ink-text-input)
    │
    ▼ onChange
setState(inputValue)
    │
    ▼
App re-render ← triggered by:
    - events[] updates (stream/reasoning/tool_call)
    - flushDisplay() every 100ms
    │
    ▼
TextInput re-render
    │
    ▼
Input state disrupted (possible race condition)
```

### Hypothesis

ink-text-input itself is fine. The problem is in **how we use it**:

**Potential issues in current code:**
1. `flushDisplay()` uses `setTimeout` + state update, may interfere with input state
2. TextInput inside main App component, affected by all parent re-renders
3. No isolation/memoization to protect input component from unrelated state changes

### Solution

**Approach: Isolate Input Component**

```typescript
// Create isolated InputPanel with React.memo
const InputPanel = React.memo(({ onSubmit }: { onSubmit: (text: string) => void }) => {
  const [value, setValue] = useState('')
  
  // This component only re-renders when value changes
  // Parent App re-renders won't trigger InputPanel re-render
  
  const handleSubmit = () => {
    onSubmit(value)
    setValue('')
  }
  
  return (
    <Box borderStyle="single">
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="Input"
      />
    </Box>
  )
})

// In App.tsx
<InputPanel onSubmit={startTask} />
```

**Key changes:**
1. Extract TextInput into separate memoized component
2. Pass `onSubmit` callback, don't depend on parent state
3. Remove TextInput from App's re-render scope

### Verification Plan

After implementing:
1. Test fast typing during idle (no LLM output)
2. Test fast typing during LLM stream output
3. Test IME input (Chinese/Japanese)
4. Monitor React DevTools for re-render frequency

---

## Problem 2: Split-Screen TUI Layout

### Current State

Single panel showing all events:
```
┌────────────────────────────────────┐
│ You: ...                           │
│ [思] thinking...                   │
│ ← tool_call                        │
│ ✓ tool_result                      │
│ Assistant: ...                     │
│                                    │
│ (all mixed together)               │
├────────────────────────────────────┤
│ Input                              │
└────────────────────────────────────┘
```

### Target Layout

```
┌─────────────────────┬─────────────────────┐
│   AI Output         │   Thinking          │
│   (左 50%)          │   (上 2/3)          │
│                     │                     │
│   [Message 1]       │   Msg 1's reasoning │
│   [Message 2] ←焦点 │   (marquee if long) │
│   [Message 3]       │                     │
│   ...               ├─────────────────────┤
│                     │   Tools             │
│   可滚动             │   (下 1/3)          │
│                     │                     │
│                     │   Msg 2's tools     │
│                     │   ← file_read       │
│                     │   ✓ bash            │
│                     │   (marquee if long) │
├─────────────────────┴─────────────────────┤
│ Input Box                                  │
└─────────────────────────────────────────────┘
```

### Focus Linkage Concept

Similar to config UI pattern:
```
Left List          Right Details
┌──────────┐      ┌──────────────────┐
│ Item A    │ ←→  │ Item A's details │
│ Item B ←焦点│    │                  │
│ Item C    │      └──────────────────┘
└──────────┘      ← 焦点联动
```

- Scroll AI Output panel → focus changes to visible message
- Thinking panel shows focused message's reasoning
- Tools panel shows focused message's tool calls

### Definition: Focus Message

A "message" = one complete LLM response (one assistant message event)

```typescript
interface MessageWithContext {
  id: string              // unique identifier
  role: 'user' | 'assistant'
  content: string         // the actual text
  reasoning: string       // thinking process before this message
  tools: ToolCall[]       // tool calls associated with this message
  timestamp: Date
}

interface ToolCall {
  name: string
  arguments: object
  status: 'running' | 'success' | 'error'
  output?: string
  timestamp: Date
}
```

### Event Association Logic

Current events are flat. Need to associate reasoning and tools to messages.

**Association rule (timestamp matching):**

```
Timeline:
  t0: user message (input)
  t1: reasoning starts
  t2: tool_call (file_read)
  t3: tool_result
  t4: reasoning continues
  t5: assistant message (output) ← THIS is the "focus message"
  t6: user message (next input)

Association:
  - reasoning (t1-t4) belongs to assistant message at t5
  - tools (t2-t3) belong to assistant message at t5
```

Implementation:
```typescript
function associateEvents(flatEvents: Event[]): MessageWithContext[] {
  const messages: MessageWithContext[] = []
  let currentReasoning = ''
  let currentTools: ToolCall[] = []
  
  for (const event of flatEvents) {
    if (event.type === 'reasoning') {
      currentReasoning += event.content
    } else if (event.type === 'tool_call') {
      currentTools.push(event)
    } else if (event.type === 'tool_result') {
      // Update matching tool status
      const tool = currentTools.find(t => t.name === event.name && t.status === 'running')
      if (tool) {
        tool.status = event.success ? 'success' : 'error'
        tool.output = event.output
      }
    } else if (event.type === 'message') {
      if (event.role === 'assistant') {
        messages.push({
          id: generateId(),
          role: 'assistant',
          content: event.content,
          reasoning: currentReasoning,
          tools: currentTools,
          timestamp: event.timestamp,
        })
        currentReasoning = ''
        currentTools = []
      } else if (event.role === 'user') {
        messages.push({
          id: generateId(),
          role: 'user',
          content: event.content,
          reasoning: '',
          tools: [],
          timestamp: event.timestamp,
        })
      }
    }
  }
  
  return messages
}
```

### Scrolling Behavior

**AI Output Panel:**
- Ink has no native scroll support (issue #765)
- Implement custom scroll: render visible slice of messages
- Track `scrollOffset` state
- Scroll changes → update `focusIndex` (find which message is in viewport center)

**Constants**:
- `MAX_VISIBLE = 15` messages (adjust based on terminal height)
- `VIEWPORT_HEIGHT` = detected via `useStdout().rows`

```typescript
const [scrollOffset, setScrollOffset] = useState(0)
const [focusIndex, setFocusIndex] = useState(0)

// Calculate visible messages
const visibleMessages = messages.slice(scrollOffset, scrollOffset + MAX_VISIBLE)

// Calculate focus from scroll position
const centerOffset = Math.floor(MAX_VISIBLE / 2)
const newFocusIndex = scrollOffset + centerOffset
```

**Thinking/Tools Panels:**
- If content fits in panel: static display
- If content exceeds panel height: marquee auto-scroll animation

```typescript
// Marquee scroll for overflowing content
function useMarqueeScroll(content: string, maxLines: number) {
  const [phase, setPhase] = useState(0)
  
  if (content.split('\n').length <= maxLines) {
    return content // no overflow
  }
  
  // Animate every 500ms
  useEffect(() => {
    const timer = setInterval(() => {
      setPhase(p => (p + 1) % contentLines.length)
    }, 500)
    return () => clearInterval(timer)
  }, [content])
  
  // Return visible slice at current phase
  const lines = content.split('\n')
  return lines.slice(phase, phase + maxLines).join('\n')
}
```

### Keyboard Controls

| Key | Action |
|-----|--------|
| ↑ / ↓ | Scroll AI Output panel |
| Enter | Submit input |
| ESC | Interrupt running task |
| Ctrl+C | Exit TUI |

Scroll automatically updates focus:
```typescript
useInput((input, key) => {
  if (key.upArrow) {
    setScrollOffset(Math.max(0, scrollOffset - 1))
  } else if (key.downArrow) {
    setScrollOffset(Math.min(messages.length - MAX_VISIBLE, scrollOffset + 1))
  }
})
```

---

## Architecture Changes

### File Structure

```
src/tui/
├── App.tsx               # Main layout (split view)
├── components/
│   ├── InputPanel.tsx    # Isolated input (memoized)
│   ├── AIOutputPanel.tsx # Left panel (scrollable)
│   ├── ThinkingPanel.tsx # Right top (marquee)
│   ├── ToolsPanel.tsx    # Right bottom (marquee)
│   └── MessageItem.tsx   # Single message render
├── hooks/
│   ├── useAgent.ts       # Agent state management (modified)
│   ├── useScroll.ts      # Custom scroll logic
│   ├── useMarquee.ts     # Marquee animation
│   └── useEventAssociation.ts # Flat events → grouped messages
└── utils/
    └── associateEvents.ts # Event grouping logic
```

### Component Hierarchy

```
App
├── Box (split layout)
│   ├── Box (left 50%)
│   │   └── AIOutputPanel
│   │       └── MessageItem (for each visible message)
│   ├── Box (right 50%)
│   │   ├── Box (top 66%)
│   │   │   └── ThinkingPanel
│   │   ├── Box (bottom 33%)
│   │   │   └── ToolsPanel
│   └── InputPanel (memoized, isolated)
```

### State Management

```typescript
interface AppState {
  // From useAgent (modified)
  isRunning: boolean
  rawEvents: Event[]              // Keep flat events for history save/load
  messages: MessageWithContext[]  // NEW: Processed for display
  
  // Live stream (during execution)
  currentReasoning: string        // Reasoning being streamed
  currentTools: ToolCall[]        // Tools being executed
  currentStream: string           // Output being streamed
  
  // Split view state
  scrollOffset: number            // Which messages are visible
  focusIndex: number              // Which message is focused
  thinkingPhase: number           // Marquee animation offset
  toolsPhase: number              // Marquee animation offset
  
  // Session metadata
  error: string | null
  sessionStart: Date | null
  taskCount: number
  
  // Input state (inside InputPanel component, NOT in AppState)
  // InputPanel manages its own value state with React.memo isolation
}
```

**State flow**:
```
Agent emits event → useAgent updates rawEvents
                  → useAgent runs associateEvents()
                  → useAgent updates messages
                  → TUI renders messages[scrollOffset:focusIndex]
```

---

## Implementation Phases

### Phase 1: Input Fix (Quick Win)

1. Extract `InputPanel` component with `React.memo`
2. Remove input state from App's state scope
3. Test and verify input stability

**Estimated time**: 1-2 hours

### Phase 2: Data Structure Refactor

1. Create `MessageWithContext` interface
2. Implement `associateEvents()` function
3. Add `processedMessages` to useAgent state (computed from rawEvents)
4. Keep `rawEvents` for backward compatibility (history save/load)
5. Update TUI to use `processedMessages` for display

**Implementation**: 
- useAgent emits both `rawEvents` (flat, for persistence) and `messages` (grouped, for display)
- `associateEvents()` runs after each new event
- history.json still saves flat events (backward compatible)

**Estimated time**: 2-3 hours

### Phase 3: Split Layout (Visual)

1. Create 4 new components: AIOutputPanel, ThinkingPanel, ToolsPanel, MessageItem
2. Implement Ink Box layout for split view
3. Basic rendering without scroll/marquee

**Estimated time**: 2-3 hours

### Phase 4: Scroll & Focus

1. Implement `useScroll` hook
2. Add keyboard controls (↑↓)
3. Focus linkage logic
4. Test scroll → focus → panel updates

**Estimated time**: 2-3 hours

### Phase 5: Marquee Animation

1. Implement `useMarquee` hook
2. Apply to ThinkingPanel and ToolsPanel
3. Tune animation speed (500ms interval)
4. Handle edge cases (empty content, single line)

**Estimated time**: 1-2 hours

### Phase 6: Testing & Polish

1. Update existing tests (test/tui.test.tsx)
2. Add tests for new components
3. Performance testing (many messages, long reasoning)
4. Fix bugs from user testing

**Estimated time**: 2-3 hours

**Total estimated**: 10-15 hours

---

## Testing Strategy

### Input Tests

```typescript
// test/input.test.tsx
describe('InputPanel', () => {
  test('fast typing during idle', async () => {
    // Type 100 chars rapidly
    // Verify no characters lost
  })
  
  test('fast typing during stream', async () => {
    // Simulate LLM stream output
    // Type simultaneously
    // Verify no interference
  })
  
  test('IME input (Chinese)', async () => {
    // Test 中文输入
    // Verify correct composition handling
  })
})
```

### Split View Tests

```typescript
// test/split-view.test.tsx
describe('Split View', () => {
  test('focus linkage', () => {
    // Scroll to message 2
    // Verify thinking panel shows msg 2's reasoning
    // Verify tools panel shows msg 2's tools
  })
  
  test('marquee scroll', () => {
    // Create long reasoning (50 lines)
    // Verify auto-scroll animation starts
  })
  
  test('keyboard scroll', () => {
    // Press ↓ 5 times
    // Verify scrollOffset increases
    // Verify focusIndex updates
  })
})
```

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Input still loses chars after memoization | Medium | High | Add stdin.on('data') fallback if needed |
| Ink scroll implementation buggy | Medium | Medium | Start simple, iterate |
| Event association logic complex | Low | Medium | Clear timestamp matching rules |
| Marquee animation performance issue | Low | Low | Use simple setTimeout, test on slow terminals |
| IME input not supported | Medium | High | Test early, may need composition events |

---

## Success Criteria

1. **Input Stability**: No character loss during fast typing (both idle and streaming)
2. **Split View**: Clean 3-panel layout renders correctly
3. **Focus Linkage**: Scroll → thinking/tools panels update within 100ms
4. **Marquee**: Long content auto-scrolls smoothly (no flicker)
5. **Performance**: Handle 100+ messages without lag
6. **Tests**: All new tests pass, existing tests updated

---

## Next Steps

After design approval:
1. Invoke `writing-plans` skill to create implementation plan
2. Start Phase 1 (input fix) - quick win, validate hypothesis
3. Iterate through remaining phases

---

## References

- Ink documentation: https://github.com/vadimdemedes/ink
- Ink issue #759 (input lag): https://github.com/vadimdemedes/ink/issues/759
- Ink issue #765 (scrolling): https://github.com/vadimdemedes/ink/issues/765
- OpenCode TUI analysis: opentui framework, similar agent UI requirements
- Claude Code: native binary, validates need for custom TUI solutions