// Checkpoint Manager - 文件快照系统（不污染 git 历史）

import fs from 'fs-extra';
import path from 'path';
import simpleGit from 'simple-git';

export interface CheckpointMeta {
  id: string;
  timestamp: string;
  promptPreview: string;
  filesBackedUp: string[];
  message: string;
}

const CHECKPOINTS_DIR = 'snapshots';
const CHECKPOINTS_JSON = 'checkpoints.json';

function getCheckpointsBase(workspacePath: string): string {
  return path.join(workspacePath, '.spica');
}

function getSnapshotsDir(workspacePath: string): string {
  return path.join(getCheckpointsBase(workspacePath), CHECKPOINTS_DIR);
}

function getCheckpointsJsonPath(workspacePath: string): string {
  return path.join(getCheckpointsBase(workspacePath), CHECKPOINTS_JSON);
}

function generateCheckpointId(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
}

// 获取 git 追踪且有变更的文件（自动遵循 .gitignore）
async function getTrackedChangedFiles(workspacePath: string): Promise<string[]> {
  const git = simpleGit(workspacePath);

  // 获取所有被 git 追踪的文件
  const trackedFiles = new Set<string>();
  try {
    const lsResult = await git.raw(['ls-files', '--cached', '--exclude-standard']);
    lsResult
      .split('\n')
      .filter(Boolean)
      .forEach(f => trackedFiles.add(f));
  } catch {
    // 非 git 仓库或出错，返回空
    return [];
  }

  // 获取有变更的文件（包括 staged 和 unstaged）
  const status = await git.status();
  const changedFiles: string[] = [];

  for (const file of status.files) {
    // 只保留被 git 追踪的文件（自动排除 .gitignore 中的文件）
    if (trackedFiles.has(file.path)) {
      changedFiles.push(file.path);
    }
  }

  return changedFiles;
}

// 创建 checkpoint（文件快照，不创建 git commit）
export async function createCheckpoint(
  workspacePath: string,
  prompt: string
): Promise<CheckpointMeta | null> {
  try {
    // 只备份 git 追踪且有变更的文件（自动遵循 .gitignore）
    const changedFiles = await getTrackedChangedFiles(workspacePath);

    // 没有变更则不创建 checkpoint
    if (changedFiles.length === 0) {
      return null;
    }

    const checkpointId = generateCheckpointId();
    const snapshotsDir = getSnapshotsDir(workspacePath);
    const checkpointDir = path.join(snapshotsDir, checkpointId);

    // 创建快照目录
    await fs.ensureDir(checkpointDir);

    // 复制所有变更的追踪文件到快照目录
    const filesBackedUp: string[] = [];
    for (const filePath of changedFiles) {
      const absolutePath = path.join(workspacePath, filePath);

      // 只备份存在的文件（删除的文件不备份）
      if (await fs.pathExists(absolutePath)) {
        const destPath = path.join(checkpointDir, filePath);
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(absolutePath, destPath);
        filesBackedUp.push(filePath);
      }
    }

    // 保存元数据
    const meta: CheckpointMeta = {
      id: checkpointId,
      timestamp: new Date().toISOString(),
      promptPreview: prompt.slice(0, 100),
      filesBackedUp,
      message: `[SPICA-CHECKPOINT] ${checkpointId} - ${prompt.slice(0, 50)}`,
    };

    await fs.writeJson(path.join(checkpointDir, 'metadata.json'), meta, { spaces: 2 });

    // 更新 checkpoints.json
    const jsonPath = getCheckpointsJsonPath(workspacePath);
    const checkpoints: CheckpointMeta[] = (await fs.pathExists(jsonPath))
      ? await fs.readJson(jsonPath)
      : [];
    checkpoints.push(meta);
    await fs.writeJson(jsonPath, checkpoints, { spaces: 2 });

    return meta;
  } catch (error) {
    // checkpoint 失败不影响 AI 工作
    console.error('Checkpoint creation failed:', error);
    return null;
  }
}

// 获取 checkpoint 列表
export async function listCheckpoints(
  workspacePath: string,
  limit?: number
): Promise<CheckpointMeta[]> {
  try {
    const jsonPath = getCheckpointsJsonPath(workspacePath);
    if (!(await fs.pathExists(jsonPath))) {
      return [];
    }

    const rawCheckpoints = await fs.readJson(jsonPath);

    // 兼容旧格式（使用 hash 字段）和新格式（使用 id 字段）
    const checkpoints: CheckpointMeta[] = rawCheckpoints.map((c: any) => ({
      id: c.id || c.hash?.substring(0, 7) || 'unknown',
      timestamp: c.timestamp,
      promptPreview: c.promptPreview || '',
      filesBackedUp: c.filesBackedUp || [],
      message: c.message || '',
    }));

    // 按时间倒序
    const sorted = checkpoints.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return limit ? sorted.slice(0, limit) : sorted;
  } catch {
    return [];
  }
}

// 获取单个 checkpoint 详情
export async function getCheckpoint(
  workspacePath: string,
  checkpointId: string
): Promise<CheckpointMeta | null> {
  try {
    const checkpointDir = path.join(getSnapshotsDir(workspacePath), checkpointId);
    const metaPath = path.join(checkpointDir, 'metadata.json');

    if (!(await fs.pathExists(metaPath))) {
      return null;
    }

    return await fs.readJson(metaPath);
  } catch {
    return null;
  }
}

// 恢复 checkpoint
export async function restoreCheckpoint(
  workspacePath: string,
  checkpointId: string
): Promise<{ success: boolean; restoredFiles: string[]; error?: string }> {
  try {
    const checkpointDir = path.join(getSnapshotsDir(workspacePath), checkpointId);

    if (!(await fs.pathExists(checkpointDir))) {
      return { success: false, restoredFiles: [], error: `Checkpoint not found: ${checkpointId}` };
    }

    const meta = (await fs.readJson(path.join(checkpointDir, 'metadata.json'))) as CheckpointMeta;
    const restoredFiles: string[] = [];

    for (const filePath of meta.filesBackedUp) {
      const srcPath = path.join(checkpointDir, filePath);
      const destPath = path.join(workspacePath, filePath);

      if (await fs.pathExists(srcPath)) {
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(srcPath, destPath, { overwrite: true });
        restoredFiles.push(filePath);
      }
    }

    return { success: true, restoredFiles };
  } catch (error) {
    return {
      success: false,
      restoredFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 清理旧 checkpoint（保留最近 N 个）
export async function cleanCheckpoints(
  workspacePath: string,
  keepCount: number = 20
): Promise<{ deleted: string[]; kept: string[] }> {
  try {
    const snapshotsDir = getSnapshotsDir(workspacePath);
    const jsonPath = getCheckpointsJsonPath(workspacePath);

    const checkpoints = await listCheckpoints(workspacePath);
    if (checkpoints.length === 0) {
      return { deleted: [], kept: [] };
    }

    const toKeep = checkpoints.slice(0, keepCount);
    const toDelete = checkpoints.slice(keepCount);

    // 删除旧快照目录（如果存在）
    const deleted: string[] = [];
    for (const meta of toDelete) {
      const checkpointDir = path.join(snapshotsDir, meta.id);
      if (await fs.pathExists(checkpointDir)) {
        await fs.remove(checkpointDir);
        deleted.push(meta.id);
      }
    }

    // 更新 checkpoints.json（只保留 toKeep）
    await fs.writeJson(jsonPath, toKeep, { spaces: 2 });

    return {
      deleted,
      kept: toKeep.map(c => c.id),
    };
  } catch {
    return { deleted: [], kept: [] };
  }
}

// 显示 checkpoint 内容（某个文件）
export async function showCheckpointFile(
  workspacePath: string,
  checkpointId: string,
  filePath: string
): Promise<string | null> {
  try {
    const snapshotPath = path.join(getSnapshotsDir(workspacePath), checkpointId, filePath);
    if (!(await fs.pathExists(snapshotPath))) {
      return null;
    }
    return await fs.readFile(snapshotPath, 'utf-8');
  } catch {
    return null;
  }
}
