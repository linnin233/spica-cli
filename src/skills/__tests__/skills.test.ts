// Test all 14 superpowers skills
import { loadSkills, getSkill, parseSkillInput, buildSkillPrompt, listSkills } from '../index';
import fs from 'fs-extra';
import path from 'path';

const SUPERPOWERS_SKILLS = [
  'brainstorming',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'using-superpowers',
  'verification-before-completion',
  'writing-plans',
  'writing-skills',
];

describe('Skills System - All 14 Superpowers', () => {
  const skillsDir = path.join(process.env.HOME || '/home/zison', '.spica', 'skills');

  beforeAll(async () => {
    // Ensure skills are initialized
    if (!fs.existsSync(skillsDir)) {
      // Copy from builtin-skills if not exists
      const builtinDir = path.join(process.cwd(), 'src', 'builtin-skills', 'superpowers');
      if (fs.existsSync(builtinDir)) {
        await fs.ensureDir(skillsDir);
        await fs.copy(builtinDir, path.join(skillsDir, 'superpowers'), { overwrite: false });
      }
    }
  });

  describe('Skill Loading', () => {
    it('should load all 14 superpowers skills', () => {
      const skills = loadSkills();
      const loadedNames = Array.from(skills.keys());

      // Check each skill exists
      for (const skillName of SUPERPOWERS_SKILLS) {
        expect(loadedNames).toContain(skillName);
      }

      expect(skills.size).toBeGreaterThanOrEqual(14);
    });

    it('should have valid skill definitions', () => {
      for (const skillName of SUPERPOWERS_SKILLS) {
        const skill = getSkill(skillName);
        expect(skill).toBeDefined();
        expect(skill!.name).toBe(skillName);
        expect(skill!.description).toBeDefined();
        expect(skill!.promptTemplate).toBeDefined();
        expect(skill!.promptTemplate!.length).toBeGreaterThan(100);
      }
    });

    it('should parse SKILL.md files correctly', () => {
      const brainstorming = getSkill('brainstorming');
      expect(brainstorming).toBeDefined();
      expect(brainstorming!.promptTemplate).toContain('brainstorm');
      expect(brainstorming!.promptTemplate).not.toContain('---'); // Frontmatter stripped
    });
  });

  describe('Skill Invocation', () => {
    it('should parse skill input /skill_name', () => {
      const parsed = parseSkillInput('/brainstorming create a new feature');
      expect(parsed).toBeDefined();
      expect(parsed!.skillName).toBe('brainstorming');
      expect(parsed!.args).toBeDefined();
    });

    it('should parse skill input /skill_name args', () => {
      const parsed = parseSkillInput('/systematic-debugging fix login bug');
      expect(parsed).toBeDefined();
      expect(parsed!.skillName).toBe('systematic-debugging');
    });

    it('should return null for non-skill input', () => {
      const parsed = parseSkillInput('/unknown-skill');
      expect(parsed).toBeNull();
    });

    it('should return null for non-/ input', () => {
      const parsed = parseSkillInput('hello world');
      expect(parsed).toBeNull();
    });
  });

  describe('Skill Prompt Building', () => {
    it('should build prompt with args', () => {
      const skill = getSkill('brainstorming');
      const prompt = buildSkillPrompt(skill!, { input: 'create a web app' });
      expect(prompt).toContain('create a web app');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('should replace template variables', () => {
      const skill = getSkill('brainstorming');
      const originalTemplate = skill!.promptTemplate;
      const prompt = buildSkillPrompt(skill!, { input: 'test input' });
      // Should have appended or replaced
      expect(prompt).toContain('test input');
    });

    it('should handle empty args', () => {
      const skill = getSkill('brainstorming');
      const prompt = buildSkillPrompt(skill!, {});
      expect(prompt).toBeDefined();
    });
  });

  describe('Individual Skill Tests', () => {
    it('brainstorming skill should contain design/brainstorm instructions', () => {
      const skill = getSkill('brainstorming');
      expect(skill!.promptTemplate).toMatch(/brainstorm|design|idea/i);
    });

    it('systematic-debugging skill should contain bug fixing instructions', () => {
      const skill = getSkill('systematic-debugging');
      expect(skill!.promptTemplate).toMatch(/bug|debug|fix/i);
    });

    it('test-driven-development skill should contain TDD instructions', () => {
      const skill = getSkill('test-driven-development');
      expect(skill!.promptTemplate).toMatch(/test|TDD|write/i);
    });

    it('writing-plans skill should contain planning instructions', () => {
      const skill = getSkill('writing-plans');
      expect(skill!.promptTemplate).toMatch(/plan|step|implement/i);
    });

    it('requesting-code-review skill should contain review instructions', () => {
      const skill = getSkill('requesting-code-review');
      expect(skill!.promptTemplate).toMatch(/review|code|subagent/i);
    });

    it('executing-plans skill should contain execution instructions', () => {
      const skill = getSkill('executing-plans');
      expect(skill!.promptTemplate).toMatch(/execute|implement|plan/i);
    });

    it('subagent-driven-development skill should contain subagent instructions', () => {
      const skill = getSkill('subagent-driven-development');
      expect(skill!.promptTemplate).toMatch(/subagent|parallel|agent/i);
    });

    it('using-git-worktrees skill should contain worktree instructions', () => {
      const skill = getSkill('using-git-worktrees');
      expect(skill!.promptTemplate).toMatch(/worktree|git|branch/i);
    });
  });

  describe('Skills List', () => {
    it('should list all skills', () => {
      const skills = listSkills();
      expect(skills.length).toBeGreaterThanOrEqual(14);
    });

    it('should return skill definitions with all fields', () => {
      const skills = listSkills();
      for (const skill of skills) {
        expect(skill.name).toBeDefined();
        expect(skill.description).toBeDefined();
      }
    });
  });
});
