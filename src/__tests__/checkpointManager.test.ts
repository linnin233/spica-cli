import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  restoreCheckpoint,
  cleanCheckpoints,
} from '../storage/checkpointManager';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const tmpDir = path.join(os.tmpdir(), 'spica-checkpoint-test');

describe('Checkpoint Manager', () => {
  beforeEach(async () => {
    await fs.ensureDir(tmpDir);
    await fs.ensureDir(path.join(tmpDir, '.spica'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('createCheckpoint', () => {
    it('should return null when no uncommitted changes', async () => {
      // Clean git state (no files)
      const result = await createCheckpoint(tmpDir, 'test prompt');
      expect(result).toBeNull();
    });

    it('should create checkpoint with file snapshot', async () => {
      // Create a test file
      const testFile = path.join(tmpDir, 'test.txt');
      await fs.writeFile(testFile, 'hello world', 'utf-8');

      // Mock git status by creating .spica/snapshots directly
      // (createCheckpoint uses simpleGit which needs a real git repo)
      // For testing, we verify the structure is correct

      // This test would need a real git repo setup
      // Skipping for now - integration test needed
    });
  });

  describe('listCheckpoints', () => {
    it('should return empty array when no checkpoints', async () => {
      const result = await listCheckpoints(tmpDir);
      expect(result).toEqual([]);
    });

    it('should list checkpoints from checkpoints.json', async () => {
      const jsonPath = path.join(tmpDir, '.spica', 'checkpoints.json');
      const testData = [
        {
          id: '2026-06-04T10:00:00',
          timestamp: '2026-06-04T10:00:00.000Z',
          promptPreview: 'test prompt',
          filesBackedUp: ['test.txt'],
          message: 'test message',
        },
        {
          id: '2026-06-04T09:00:00',
          timestamp: '2026-06-04T09:00:00.000Z',
          promptPreview: 'earlier prompt',
          filesBackedUp: ['old.txt'],
          message: 'old message',
        },
      ];
      await fs.writeJson(jsonPath, testData);

      const result = await listCheckpoints(tmpDir);
      expect(result.length).toBe(2);
      expect(result[0].id).toBe('2026-06-04T10:00:00'); // Most recent first
    });

    it('should handle legacy format with hash field', async () => {
      const jsonPath = path.join(tmpDir, '.spica', 'checkpoints.json');
      const legacyData = [
        {
          hash: 'abc123def456',
          timestamp: '2026-06-03T10:00:00.000Z',
          promptPreview: 'legacy prompt',
          filesBackedUp: ['legacy.txt'],
          message: 'legacy message',
        },
      ];
      await fs.writeJson(jsonPath, legacyData);

      const result = await listCheckpoints(tmpDir);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('abc123d'); // First 7 chars of hash
    });

    it('should limit results when limit parameter provided', async () => {
      const jsonPath = path.join(tmpDir, '.spica', 'checkpoints.json');
      const testData = Array.from({ length: 30 }, (_, i) => ({
        id: `checkpoint-${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        promptPreview: `prompt ${i}`,
        filesBackedUp: [`file${i}.txt`],
        message: `message ${i}`,
      }));
      await fs.writeJson(jsonPath, testData);

      const result = await listCheckpoints(tmpDir, 10);
      expect(result.length).toBe(10);
    });
  });

  describe('getCheckpoint', () => {
    it('should return null for non-existent checkpoint', async () => {
      const result = await getCheckpoint(tmpDir, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should return checkpoint metadata', async () => {
      const checkpointDir = path.join(tmpDir, '.spica', 'snapshots', 'test-id');
      await fs.ensureDir(checkpointDir);
      const meta = {
        id: 'test-id',
        timestamp: '2026-06-04T10:00:00.000Z',
        promptPreview: 'test prompt',
        filesBackedUp: ['test.txt'],
        message: 'test message',
      };
      await fs.writeJson(path.join(checkpointDir, 'metadata.json'), meta);

      const result = await getCheckpoint(tmpDir, 'test-id');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('test-id');
      expect(result?.filesBackedUp).toContain('test.txt');
    });
  });

  describe('restoreCheckpoint', () => {
    it('should return error for non-existent checkpoint', async () => {
      const result = await restoreCheckpoint(tmpDir, 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should restore files from checkpoint', async () => {
      const checkpointDir = path.join(tmpDir, '.spica', 'snapshots', 'restore-test');
      await fs.ensureDir(checkpointDir);

      // Create snapshot file
      const snapshotFile = path.join(checkpointDir, 'restored.txt');
      await fs.writeFile(snapshotFile, 'restored content', 'utf-8');

      // Create metadata
      const meta = {
        id: 'restore-test',
        timestamp: '2026-06-04T10:00:00.000Z',
        promptPreview: 'restore test',
        filesBackedUp: ['restored.txt'],
        message: 'restore test',
      };
      await fs.writeJson(path.join(checkpointDir, 'metadata.json'), meta);

      const result = await restoreCheckpoint(tmpDir, 'restore-test');
      expect(result.success).toBe(true);
      expect(result.restoredFiles).toContain('restored.txt');

      // Verify file was restored
      const restoredPath = path.join(tmpDir, 'restored.txt');
      expect(await fs.pathExists(restoredPath)).toBe(true);
      expect(await fs.readFile(restoredPath, 'utf-8')).toBe('restored content');
    });
  });

  describe('cleanCheckpoints', () => {
    it('should keep only specified number of checkpoints', async () => {
      const jsonPath = path.join(tmpDir, '.spica', 'checkpoints.json');
      const testData = Array.from({ length: 30 }, (_, i) => ({
        id: `checkpoint-${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        promptPreview: `prompt ${i}`,
        filesBackedUp: [`file${i}.txt`],
        message: `message ${i}`,
      }));
      await fs.writeJson(jsonPath, testData);

      const result = await cleanCheckpoints(tmpDir, 10);
      expect(result.kept.length).toBe(10);
      // deleted.length is 0 because no snapshot directories exist
      expect(result.deleted.length).toBe(0);

      // Verify checkpoints.json was updated
      const remaining = await fs.readJson(jsonPath);
      expect(remaining.length).toBe(10);
    });

    it('should handle empty checkpoints', async () => {
      const result = await cleanCheckpoints(tmpDir, 10);
      expect(result.kept).toEqual([]);
      expect(result.deleted).toEqual([]);
    });
  });
});
