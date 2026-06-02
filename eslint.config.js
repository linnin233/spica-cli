import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
      'no-case-declarations': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
    }
  },
  {
    ignores: ['dist', 'node_modules', '**/*.test.ts', '**/*.spec.ts', 'bin']
  }
);