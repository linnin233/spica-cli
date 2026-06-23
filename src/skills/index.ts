// Skills系统 - 用户自定义命令

import fs from 'fs-extra';
import { join, dirname, basename } from 'path';
import { execa } from 'execa';
import { fileURLToPath } from 'url';
import { GLOBAL_DIR, SkillDefinition, loadProjectSkills } from '../utils/settings';

// ES module 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 默认 skills 包源码目录（随 spica-cli npm 分发）
const DEFAULT_PACKAGE_DIR = join(__dirname, '..', 'builtin-skills');
// 用户 skills 目录（统一存放所有 skills）
const SKILLS_DIR = join(GLOBAL_DIR, 'skills');

// Skill 包信息
export interface SkillPackageInfo {
  name: string;
  skills: string[];
}

// 初始化：首次运行时复制默认包到用户目录（不覆盖已有）
export async function initSkills(): Promise<void> {
  if (!fs.existsSync(SKILLS_DIR)) {
    await fs.ensureDir(SKILLS_DIR);

    // 复制默认包（如 superpowers）
    if (fs.existsSync(DEFAULT_PACKAGE_DIR)) {
      const packages = fs.readdirSync(DEFAULT_PACKAGE_DIR).filter(d => {
        const fullPath = join(DEFAULT_PACKAGE_DIR, d);
        return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
      });

      for (const pkgName of packages) {
        const srcDir = join(DEFAULT_PACKAGE_DIR, pkgName);
        const destDir = join(SKILLS_DIR, pkgName);
        await fs.copy(srcDir, destDir, { overwrite: false }); // 不覆盖已有
      }
    }
  }
}

// 加载所有 skills（统一目录 -> 项目补充）
export function loadSkills(workspacePath?: string): Map<string, SkillDefinition> {
  const skills = new Map<string, SkillDefinition>();
  const ws = workspacePath || process.cwd();

  // 1. 加载用户 skills 目录（所有安装的 skills）
  if (fs.existsSync(SKILLS_DIR)) {
    const packageDirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      const fullPath = join(SKILLS_DIR, d);
      return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
    });
    for (const pkgName of packageDirs) {
      loadSkillsFromDir(join(SKILLS_DIR, pkgName), skills);
    }
  }

  // 2. 加载项目 skills（只补充）
  const projectSkills = loadProjectSkills(ws);
  if (projectSkills) {
    Object.entries(projectSkills).forEach(([name, def]) => {
      if (!skills.has(name)) {
        def.name = name;
        skills.set(name, def);
      }
    });
  }

  return skills;
}

// 从目录加载 skills
function loadSkillsFromDir(dir: string, skills: Map<string, SkillDefinition>): void {
  if (!fs.existsSync(dir)) return;

  const dirs = fs.readdirSync(dir).filter(d => {
    const fullPath = join(dir, d);
    return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
  });

  for (const dirName of dirs) {
    const skillFile = join(dir, dirName, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const skillDef = parseSkillMarkdown(dirName, content);
        if (skillDef) {
          // 已有的不被覆盖
          if (!skills.has(dirName)) {
            skills.set(dirName, skillDef);
          }
        }
      } catch {}
    }
  }
}

// 解析 SKILL.md 文件
function parseSkillMarkdown(name: string, content: string): SkillDefinition | null {
  let skillName = name;
  let description = `Skill: ${name}`;
  let promptTemplate = content;

  // 解析 YAML frontmatter
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx).trim();
      const body = content.slice(endIdx + 3).trim();

      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);

      if (nameMatch) skillName = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
      promptTemplate = body || content;
    }
  }

  return {
    name: skillName,
    description,
    promptTemplate,
  };
}

// 获取skill定义
export function getSkill(name: string, workspacePath?: string): SkillDefinition | null {
  return loadSkills(workspacePath).get(name) || null;
}

// 检查输入是否是skill调用
export function parseSkillInput(
  input: string,
  workspacePath?: string
): { skillName: string; args: Record<string, any> } | null {
  const trimmed = input.trim();

  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const skillName = parts[0];
    const args = parts.slice(1).join(' ');

    const skill = getSkill(skillName, workspacePath);
    if (skill) {
      const templateArgs = parseTemplateArgs(skill.promptTemplate, args);
      return { skillName, args: templateArgs };
    }
  }

  return null;
}

// 解析模板变量
function parseTemplateArgs(template: string | undefined, input: string): Record<string, any> {
  if (!template) {
    return { input };
  }

  const vars = template.match(/\{(\w+)\}/g) || [];
  const varNames = vars.map(v => v.slice(1, -1));

  const args: Record<string, any> = {};

  if (varNames.length === 1) {
    args[varNames[0]] = input;
  } else if (varNames.length > 1) {
    const parts = input.split(/[,\s]+/);
    varNames.forEach((name, i) => {
      args[name] = parts[i] || '';
    });
  } else {
    args.input = input;
  }

  return args;
}

// 构建skill prompt
export function buildSkillPrompt(skill: SkillDefinition, args: Record<string, any>): string {
  let prompt = skill.promptTemplate || '';

  Object.entries(args).forEach(([key, value]) => {
    prompt = prompt.replace(`{${key}}`, value);
  });

  if (!skill.promptTemplate?.match(/\{(\w+)\}/) && args.input) {
    prompt += `\n\nUser request: ${args.input}`;
  }

  if (!skill.promptTemplate) {
    return Object.entries(args)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }

  return prompt;
}

// 列出所有skills
export function listSkills(workspacePath?: string): SkillDefinition[] {
  return Array.from(loadSkills(workspacePath).values());
}

// List skills grouped by package name (for categorized tab completion).
export function listSkillsByPackage(workspacePath?: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const ws = workspacePath || process.cwd();

  if (!fs.existsSync(SKILLS_DIR)) return groups;

  const packageDirs = fs.readdirSync(SKILLS_DIR).filter(d => {
    const fullPath = join(SKILLS_DIR, d);
    return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
  });

  for (const pkgName of packageDirs) {
    const skills = getPackageSkills(pkgName);
    // Resolve each skill's install name (from SKILL.md frontmatter)
    const names: string[] = [];
    for (const skillDir of skills) {
      const skillFile = join(SKILLS_DIR, pkgName, skillDir, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        try {
          const content = fs.readFileSync(skillFile, 'utf-8');
          const skillDef = parseSkillMarkdown(skillDir, content);
          if (skillDef) names.push(`/${skillDef.name}`);
        } catch {}
      }
    }
    if (names.length > 0) {
      groups[pkgName] = names.sort();
    }
  }

  return groups;
}

// 列出已安装的包
export async function listInstalledPackages(): Promise<SkillPackageInfo[]> {
  const packages: SkillPackageInfo[] = [];

  if (!fs.existsSync(SKILLS_DIR)) {
    return packages;
  }

  const dirs = fs.readdirSync(SKILLS_DIR).filter(d => {
    const fullPath = join(SKILLS_DIR, d);
    return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
  });

  for (const pkgName of dirs) {
    const skills = getPackageSkills(pkgName);
    packages.push({
      name: pkgName,
      skills,
    });
  }

  return packages;
}

// 获取包中的 skills 列表
function getPackageSkills(pkgName: string): string[] {
  const pkgDir = join(SKILLS_DIR, pkgName);
  if (!fs.existsSync(pkgDir)) return [];

  const dirs = fs.readdirSync(pkgDir).filter(d => {
    const fullPath = join(pkgDir, d);
    return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
  });

  return dirs.filter(d => fs.existsSync(join(pkgDir, d, 'SKILL.md')));
}

// 安装 skill 包（从 GitHub 或本地目录，不覆盖已有）
export async function installSkill(
  source: string
): Promise<{ success: boolean; message: string; skills?: string[] }> {
  try {
    await fs.ensureDir(SKILLS_DIR);

    let pkgName: string;
    let sourceDir: string;

    // GitHub URL
    if (source.includes('github.com')) {
      const match = source.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        return { success: false, message: 'Invalid GitHub URL format' };
      }

      pkgName = match[2];
      const tempDir = join(SKILLS_DIR, `_temp_${pkgName}`);

      await execa('git', ['clone', '--depth', '1', source, tempDir]);

      if (fs.existsSync(join(tempDir, 'skills'))) {
        sourceDir = join(tempDir, 'skills');
      } else {
        sourceDir = tempDir;
      }

      const destDir = join(SKILLS_DIR, pkgName);
      // 不覆盖已有的包
      if (fs.existsSync(destDir)) {
        await fs.remove(tempDir);
        return {
          success: false,
          message: `Package "${pkgName}" already exists. Delete it first to reinstall.`,
        };
      }

      await fs.copy(sourceDir, destDir, { overwrite: false });
      await fs.remove(tempDir);
    }
    // 本地目录
    else if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
      pkgName = basename(source);
      sourceDir = source;
      const destDir = join(SKILLS_DIR, pkgName);

      if (fs.existsSync(destDir)) {
        return {
          success: false,
          message: `Package "${pkgName}" already exists. Delete it first to reinstall.`,
        };
      }

      await fs.copy(sourceDir, destDir, { overwrite: false });
    } else {
      return { success: false, message: 'Source must be GitHub URL or local directory' };
    }

    const skills = getPackageSkills(pkgName);
    return {
      success: true,
      message: `Installed ${pkgName}`,
      skills,
    };
  } catch (_error: any) {
    return { success: false, message: `Install failed: ${_error.message}` };
  }
}

// 卸载 skill 包
export async function uninstallSkill(
  packageName: string
): Promise<{ success: boolean; message: string }> {
  try {
    const pkgDir = join(SKILLS_DIR, packageName);

    if (!fs.existsSync(pkgDir)) {
      return { success: false, message: `Package "${packageName}" not found` };
    }

    await fs.remove(pkgDir);
    return { success: true, message: `Uninstalled ${packageName}` };
  } catch (_error: any) {
    return { success: false, message: `Uninstall failed: ${_error.message}` };
  }
}

// 保存单个 skill（写入到指定包目录）
export async function saveSkill(
  skillName: string,
  skill: SkillDefinition,
  pkgName: string = 'custom'
): Promise<boolean> {
  try {
    const pkgDir = join(SKILLS_DIR, pkgName);
    await fs.ensureDir(pkgDir);

    const skillDir = join(pkgDir, skillName);
    await fs.ensureDir(skillDir);

    const skillFile = join(skillDir, 'SKILL.md');
    const content = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.promptTemplate || ''}`;
    await fs.writeFile(skillFile, content);

    return true;
  } catch {
    // Failed to save skill - non-critical error
    return false;
  }
}

// 删除单个 skill
export async function deleteSkill(skillName: string, pkgName?: string): Promise<boolean> {
  try {
    if (pkgName) {
      const skillDir = join(SKILLS_DIR, pkgName, skillName);
      if (fs.existsSync(skillDir)) {
        await fs.remove(skillDir);
        return true;
      }
      return false;
    }

    // 搜索所有包
    if (!fs.existsSync(SKILLS_DIR)) return false;

    const dirs = fs.readdirSync(SKILLS_DIR).filter(d => {
      const fullPath = join(SKILLS_DIR, d);
      return fs.statSync(fullPath).isDirectory() && !d.startsWith('_') && !d.startsWith('.');
    });

    for (const pkg of dirs) {
      const skillDir = join(SKILLS_DIR, pkg, skillName);
      if (fs.existsSync(skillDir)) {
        await fs.remove(skillDir);
        return true;
      }
    }

    return false;
  } catch {
    // Failed to delete skill - non-critical error
    return false;
  }
}
