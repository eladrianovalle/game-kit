// Holds the kit's import boundary: the kit knows no game and needs no package.

import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importsUnder, isInside, isTestFile } from '../testing/imports';

const KIT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WEB_DIRECTORY = join(KIT_DIRECTORY, '..');
const GAME_DIRECTORY = join(WEB_DIRECTORY, 'game');

const describeImport = (entry: { file: string; specifier: string }): string =>
  `${relative(WEB_DIRECTORY, entry.file)} imports '${entry.specifier}'`;

describe('import boundary: the kit imports no game file and no package', () => {
  const kitImports = importsUnder(KIT_DIRECTORY);

  it('finds the kit files it is meant to check', () => {
    const files = new Set(kitImports.map((entry) => relative(KIT_DIRECTORY, entry.file)));
    expect(files).toContain('keyboard.ts');
  });

  it('no kit file, tests included, imports from web/game', () => {
    const offenders = kitImports
      .filter((entry) => entry.resolved !== null && isInside(entry.resolved, GAME_DIRECTORY))
      .map(describeImport);
    expect(offenders).toEqual([]);
  });

  it('no kit file imports a package, and every import stays inside the kit (tests may also use the test runner and test helpers)', () => {
    const offenders = kitImports
      .filter((entry) => !isTestFile(entry.file))
      .filter((entry) => entry.resolved === null || !isInside(entry.resolved, KIT_DIRECTORY))
      .map(describeImport);
    expect(offenders).toEqual([]);
  });
});
