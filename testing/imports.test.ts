import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, listImports } from './imports';

describe('listImports', () => {
  it('finds value imports, type imports, bare imports, re-exports and on-demand imports', () => {
    const source = [
      "import { createClock } from './clock';",
      "import type { Actions } from '../kit/actions';",
      "import { type Disposer, createDisposer } from './lifecycle';",
      "import './side-effect';",
      "export { mount } from './main';",
      "export type { Mount } from './host';",
      'import {',
      '  Sprite,',
      "} from 'pixi.js';",
      "const lazy = await import('./lazy');",
    ].join('\n');

    expect(listImports(source)).toEqual([
      { specifier: './clock', typeOnly: false },
      { specifier: '../kit/actions', typeOnly: true },
      { specifier: './lifecycle', typeOnly: false },
      { specifier: './side-effect', typeOnly: false },
      { specifier: './main', typeOnly: false },
      { specifier: './host', typeOnly: true },
      { specifier: 'pixi.js', typeOnly: false },
      { specifier: './lazy', typeOnly: false },
    ]);
  });

  it('does not mistake a quoted word in a comment for an import', () => {
    expect(listImports("// the 'play' screen\nconst from = 'here';")).toEqual([]);
  });
});

describe('isInside', () => {
  it('does not treat a sibling with a longer name as inside', () => {
    expect(isInside(join(sep, 'web', 'kit', 'clock.ts'), join(sep, 'web', 'kit'))).toBe(true);
    expect(isInside(join(sep, 'web', 'kit-extras', 'clock.ts'), join(sep, 'web', 'kit'))).toBe(false);
  });

  it('uses the platform separator, so a Windows path resolved by node:path counts as inside', () => {
    const directory = resolve('web', 'kit');
    expect(isInside(resolve('web', 'kit', 'clock.ts'), directory)).toBe(true);
    expect(isInside(directory, directory)).toBe(true);
    expect(isInside(resolve('web', 'game', 'clock.ts'), directory)).toBe(false);
  });
});
