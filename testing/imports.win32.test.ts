// `isInside` on Windows, where `node:path` builds paths with backslashes. CI runs on Linux,
// so this file mocks `node:path` as its `win32` flavour and feeds real Windows paths; without
// the mock the platform-separator fix would be indistinguishable from the old slash check.

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async () => (await vi.importActual<typeof import('node:path')>('node:path')).win32);

const { isInside } = await import('./imports');

describe('isInside on Windows paths', () => {
  it('counts a file under the directory as inside, and a sibling with a longer name as outside', () => {
    expect(isInside('C:\\web\\kit\\clock.ts', 'C:\\web\\kit')).toBe(true);
    expect(isInside('C:\\web\\kit', 'C:\\web\\kit')).toBe(true);
    expect(isInside('C:\\web\\kit-extras\\clock.ts', 'C:\\web\\kit')).toBe(false);
    expect(isInside('C:\\web\\game\\clock.ts', 'C:\\web\\kit')).toBe(false);
  });
});
