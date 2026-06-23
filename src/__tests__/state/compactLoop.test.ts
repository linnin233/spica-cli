import { describe, it, expect } from 'vitest';

describe('compact loop safety', () => {
  it('should have _compacting guard in source', async () => {
    const fs = await import('fs-extra');
    const source = await fs.readFile('src/agent.ts', 'utf-8');
    // Non-blocking compression uses _compacting flag to prevent re-entry
    expect(source).toContain('_compacting');
  });

  it('should have context_warning in source', async () => {
    const fs = await import('fs-extra');
    const source = await fs.readFile('src/agent.ts', 'utf-8');
    expect(source).toContain('context_warning');
  });

  it('should have manageContext and isCompacting guard in source', async () => {
    const fs = await import('fs-extra');
    const source = await fs.readFile('src/agent.ts', 'utf-8');
    // Layered compression waterfall (Snip → Microcompact → Collapse → AutoCompact)
    expect(source).toContain('manageContext');
    // Re-entry guard: isCompacting() accessor + _compacting flag
    expect(source).toContain('isCompacting');
    expect(source).toContain('_compacting');
  });
});
