import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExec, mockExistsSync, mockPlatform } = vi.hoisted(() => ({
  mockExec: vi.fn((_cmd: any, cb?: any) => {
    if (cb) cb(null, '', '');
    return {};
  }),
  mockExistsSync: vi.fn((_p: any) => false),
  mockPlatform: vi.fn(() => 'linux'),
}));

vi.mock('child_process', () => ({ exec: mockExec }));
vi.mock('fs', () => ({ existsSync: mockExistsSync }));
vi.mock('os', () => ({ platform: mockPlatform }));

describe('playBell', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockReturnValue(true);
  });

  it('does nothing when SPICA_BELL is "false"', async () => {
    const { playBell } = await import('../bell');
    playBell('done', { env: { SPICA_BELL: 'false' } });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('defaults to enabled when SPICA_BELL is not set', async () => {
    const { playBell } = await import('../bell');
    playBell('done', { env: {} });
    expect(mockExec).toHaveBeenCalled();
  });

  it('plays custom sound file when env var points to existing file', async () => {
    mockExistsSync.mockImplementation((p: any) => p === '/my/custom.wav');
    const { playBell } = await import('../bell');
    playBell('done', { env: { SPICA_BELL_DONE: '/my/custom.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/my/custom.wav'),
      expect.any(Function)
    );
  });

  it('falls back to default when custom file does not exist', async () => {
    mockExistsSync.mockImplementation((p: any) => p !== '/nonexistent.wav');
    const { playBell } = await import('../bell');
    playBell('done', { env: { SPICA_BELL_DONE: '/nonexistent.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('complete.oga'),
      expect.any(Function)
    );
  });

  it('uses SPICA_BELL_PERMISSION for permission reason', async () => {
    mockExistsSync.mockImplementation((p: any) => p === '/perm.wav');
    const { playBell } = await import('../bell');
    playBell('permission', { env: { SPICA_BELL_PERMISSION: '/perm.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/perm.wav'),
      expect.any(Function)
    );
  });

  it('uses SPICA_BELL_ERROR for error reason', async () => {
    mockExistsSync.mockImplementation((p: any) => p === '/err.wav');
    const { playBell } = await import('../bell');
    playBell('error', { env: { SPICA_BELL_ERROR: '/err.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/err.wav'),
      expect.any(Function)
    );
  });

  it('tries pw-play, paplay, aplay in order on linux', async () => {
    mockPlatform.mockReturnValue('linux');
    let callCount = 0;
    mockExec.mockImplementation((_cmd: any, cb?: any) => {
      callCount++;
      if (cb) cb(new Error('fail'), '', '');
      return {};
    });

    const { playBell } = await import('../bell');
    playBell('done', { env: {} });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('uses afplay on darwin', async () => {
    mockPlatform.mockReturnValue('darwin');
    const { playBell } = await import('../bell');
    playBell('done', { env: {} });
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('afplay'), expect.any(Function));
  });
});

describe('isBellEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns true when SPICA_BELL is not set', async () => {
    const { isBellEnabled } = await import('../bell');
    expect(isBellEnabled()).toBe(true);
  });

  it('returns false when SPICA_BELL is "false"', async () => {
    const original = process.env.SPICA_BELL;
    process.env.SPICA_BELL = 'false';
    const { isBellEnabled } = await import('../bell');
    expect(isBellEnabled()).toBe(false);
    if (original === undefined) {
      delete process.env.SPICA_BELL;
    } else {
      process.env.SPICA_BELL = original;
    }
  });
});
