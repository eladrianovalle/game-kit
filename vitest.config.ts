import { defineConfig } from 'vitest/config';

// Named folders only, so a copy of the repo under .claude/worktrees/ or a test
// file inside Studio's snapshot is never run as this repo's test.
export default defineConfig({
  test: {
    include: ['kit/**/*.test.ts', 'testing/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
