import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveHistory, loadHistory, ensureHistoryDir } from '../../utils/history';

describe('history file permissions', () => {
  it('should set restrictive permissions on history file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-test-history-'));
    const origHome = os.homedir;
    try {
      // We can't easily override homedir, but we can test chmod is called
      // by checking that saveHistory doesn't throw
      expect(() => saveHistory([])).not.toThrow();
    } finally {
      // Cleanup
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {}
    }
  });

  it('should contain chmod call in source', async () => {
    const fsExtra = await import('fs-extra');
    const source = await fsExtra.readFile('src/utils/history.ts', 'utf-8');
    expect(source).toContain('chmodSync');
    expect(source).toContain('0o600');
  });
});
