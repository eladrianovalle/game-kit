import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('the host contract', () => {
  // The kit knows no game. A second game with no Levels or waves must be able
  // to satisfy the same contract, so the contract may not mention either.
  it('web/kit/host.ts names no Level and no wave', () => {
    const source = readFileSync(fileURLToPath(new URL('./host.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/level/i);
    expect(source).not.toMatch(/wave/i);
  });
});
