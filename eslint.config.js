// Zero warnings tolerated: `npm run check` runs eslint with --max-warnings=0.
// The rules are Into The Dark's, because that game lints its copy of kit/ and
// testing/ with zero warnings and may not edit the files. If a rule complains
// about a file under kit/ or testing/, the fix is a kit pull request or a
// change here, never a quiet reformat of an imported file.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .claude/ and .studio/ hold Studio's workflow scripts, which are not this repo's code.
  { ignores: ['dist/', 'node_modules/', '.studio/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.js'],
    rules: {
      // Named-in-full is the house style; a leading underscore marks a parameter kept for its position.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // Node scripts and config: plain JavaScript, Node globals.
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' },
    },
  },
);
