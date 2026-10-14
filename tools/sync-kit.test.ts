// The tool's test. It reads no pin from this repo: each case builds a tiny
// source repo and a game folder in a temp folder, and drives the script with
// --root. The source repo's history is:
//
//   first   kit/ and testing/ only               on origin/main
//   second  adds tools/sync-kit.mjs, edits kit   on origin/main (its head)
//   side    edits kit again                      on no branch that origin/main holds

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = join(TOOLS_DIRECTORY, 'sync-kit.mjs');
const ABSENT_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const ALL_THREE = [
  { from: 'kit', to: 'kit' },
  { from: 'testing', to: 'testing' },
  { from: 'tools/sync-kit.mjs', to: 'tools/sync-kit.mjs' },
];
const SYNCED_FILES = ['kit/actions.ts', 'kit/clock.ts', 'testing/fake-time.ts', 'tools/sync-kit.mjs'];

interface Source {
  checkout: string;
  first: string;
  second: string;
  side: string;
}

const temporaryFolders: string[] = [];
let source: Source;
let sourceWithoutMain: Source;

function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'sync-kit-'));
  temporaryFolders.push(folder);
  return folder;
}

function git(checkout: string, ...commandLine: string[]): string {
  const identity = ['-c', 'user.name=Sync Kit Test', '-c', 'user.email=sync-kit-test@example.invalid', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', ['-C', checkout, ...identity, ...commandLine], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeFiles(folder: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
}

function commitAll(checkout: string, message: string, files: Record<string, string>): string {
  writeFiles(checkout, files);
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', message);
  return git(checkout, 'rev-parse', 'HEAD');
}

function buildSource({ withOriginMain }: { withOriginMain: boolean }): Source {
  const checkout = temporaryFolder();
  git(checkout, 'init', '-q');
  const first = commitAll(checkout, 'first', {
    'kit/actions.ts': 'export const actions = 1;\n',
    'kit/clock.ts': 'export const clock = 1;\n',
    'testing/fake-time.ts': 'export const fakeTime = 1;\n',
  });
  const second = commitAll(checkout, 'second', {
    'kit/clock.ts': 'export const clock = 2;\n',
    'tools/sync-kit.mjs': '// the tool as the source repo holds it\n',
  });
  if (withOriginMain) {
    git(checkout, 'update-ref', 'refs/remotes/origin/main', second);
  }
  const side = commitAll(checkout, 'side', { 'kit/clock.ts': 'export const clock = 3;\n' });
  // Leave the working files unlike any commit: the tool must read git objects, never these.
  writeFiles(checkout, { 'kit/clock.ts': 'uncommitted work\n' });
  return { checkout, first, second, side };
}

/** An empty game folder holding only a pin, with no hashes recorded yet. */
function gameWithPin(commit: string, copies: Array<{ from: string; to: string }> = ALL_THREE): string {
  const game = temporaryFolder();
  writeFiles(game, {
    'kit/KIT_SOURCE.json': `${JSON.stringify({ repository: 'for people only', commit, copies }, null, 2)}\n`,
  });
  return game;
}

/** A game folder synced at a commit, hashes recorded. */
function syncedGame(commit: string): string {
  const game = gameWithPin(commit);
  expect(run(game, '--from', source.checkout).status).toBe(0);
  return game;
}

/** Runs the script on a game folder. Holds, for every case, that nothing looks like a stack trace and that exit 2 prints one line. */
function run(game: string, ...options: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [SYNC_SCRIPT, '--root', game, ...options], { encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  expect(output).not.toMatch(/^\s+at .+:\d+/m);
  expect(output).not.toMatch(/node:internal|file:\/\/|\bfatal:/);
  if (result.status === 2) {
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(output).toMatch(/^sync-kit\.mjs: /);
  }
  return { status: result.status, output };
}

/** Every file under a folder, by path, as text. Two equal snapshots mean no byte moved and no file came or went. */
function snapshot(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[relative(folder, path)] = readFileSync(path, 'latin1');
    }
  }
  return files;
}

function readPin(game: string): { commit: string; sha256?: Record<string, string> } {
  return JSON.parse(readFileSync(join(game, 'kit', 'KIT_SOURCE.json'), 'utf8'));
}

beforeAll(() => {
  source = buildSource({ withOriginMain: true });
  sourceWithoutMain = buildSource({ withOriginMain: false });
});

afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('sync-kit.mjs --from <checkout>: copy the pinned commit in', () => {
  it('copies every file of every copies entry at the pinned commit and records a hash for each', () => {
    const game = gameWithPin(source.second);
    const result = run(game, '--from', source.checkout);

    expect(result.status).toBe(0);
    expect(result.output).toContain(`sync-kit.mjs: copied 4 file(s) from ${source.second}`);
    expect(result.output).not.toContain('note:');
    for (const file of SYNCED_FILES) {
      expect(readFileSync(join(game, file), 'utf8')).toBe(git(source.checkout, 'show', `${source.second}:${file}`) + '\n');
    }
    // The pinned commit's bytes, not the checkout's working files or its branch head.
    expect(readFileSync(join(game, 'kit/clock.ts'), 'utf8')).toBe('export const clock = 2;\n');

    const pin = readPin(game);
    expect(pin.commit).toBe(source.second);
    expect(Object.keys(pin.sha256 ?? {})).toEqual(SYNCED_FILES);
    for (const hash of Object.values(pin.sha256 ?? {})) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('copies nothing the second time, and leaves a file of the game that the kit does not hold alone', () => {
    const game = syncedGame(source.second);
    writeFiles(game, { 'testing/the-games-own.test.ts': 'the game wrote this\n' });
    const before = snapshot(game);

    const result = run(game, '--from', source.checkout);
    expect(result.status).toBe(0);
    expect(result.output).toContain(`sync-kit.mjs: copied 0 file(s) from ${source.second}`);
    expect(snapshot(game)).toEqual(before);
  });

  it('for a commit on a side branch only: copies, records hashes, prints the not-on-main note and exits 0', () => {
    const game = gameWithPin(source.side);
    const result = run(game, '--from', source.checkout);

    expect(result.status).toBe(0);
    expect(result.output).toContain(`sync-kit.mjs: copied 4 file(s) from ${source.side}`);
    expect(result.output).toContain(`sync-kit.mjs: note: ${source.side} is not on origin/main of ${source.checkout}`);
    expect(readFileSync(join(game, 'kit/clock.ts'), 'utf8')).toBe('export const clock = 3;\n');
    expect(Object.keys(readPin(game).sha256 ?? {})).toEqual(SYNCED_FILES);
  });
});

describe('sync-kit.mjs --check: compare with the recorded hashes, no other checkout needed', () => {
  it('passes on an untouched copy', () => {
    const game = syncedGame(source.second);
    const result = run(game, '--check');
    expect(result.status).toBe(0);
    expect(result.output).toContain(`sync-kit.mjs: the vendored kit files match ${source.second}`);
  });

  it('fails when one byte of one file is changed, names only that file, and says what to do', () => {
    const game = syncedGame(source.second);
    const edited = join(game, 'kit', 'clock.ts');
    const bytes = readFileSync(edited);
    bytes[bytes.length - 2] ^= 1;
    writeFileSync(edited, bytes);

    const result = run(game, '--check');
    expect(result.status).toBe(1);
    expect(result.output).toContain(`sync-kit.mjs: FAILED: these files differ from the hashes recorded for ${source.second}:`);
    expect(result.output).toContain('  kit/clock.ts\n');
    for (const untouched of ['kit/actions.ts', 'testing/fake-time.ts', '  tools/sync-kit.mjs']) {
      expect(result.output).not.toContain(untouched);
    }
    expect(result.output).toContain('it belongs in game-kit');
    expect(result.output).toContain('flow (c)');
    expect(result.output).toContain('node tools/sync-kit.mjs --from <path to a game-kit checkout>');
  });

  it('fails when a file is missing, and names it', () => {
    const game = syncedGame(source.second);
    rmSync(join(game, 'testing', 'fake-time.ts'));

    const result = run(game, '--check');
    expect(result.status).toBe(1);
    expect(result.output).toContain('  testing/fake-time.ts\n');
    expect(result.output).not.toContain('kit/clock.ts');
  });

  it('exits 2 with one line when the pin records no hashes', () => {
    const game = gameWithPin(source.second);
    const result = run(game, '--check');
    expect(result.status).toBe(2);
    expect(result.output).toContain('KIT_SOURCE.json records no hashes. Run: node tools/sync-kit.mjs --from <path to a game-kit checkout>');
  });

  it('exits 2 with one line when there is no pin file, or it is not JSON', () => {
    const game = temporaryFolder();
    expect(run(game, '--check').status).toBe(2);
    writeFiles(game, { 'kit/KIT_SOURCE.json': '{ not json' });
    expect(run(game, '--check').status).toBe(2);
    expect(run(game, '--from', source.checkout).status).toBe(2);
  });
});

describe('sync-kit.mjs --from <checkout> --check: compare with the pinned commit, change nothing', () => {
  it('passes for a commit on origin/main, needs no recorded hashes, and writes nothing', () => {
    const game = syncedGame(source.second);
    const pinPath = join(game, 'kit', 'KIT_SOURCE.json');
    writeFileSync(pinPath, `${JSON.stringify({ ...readPin(game), sha256: undefined }, null, 2)}\n`);
    const before = snapshot(game);

    const result = run(game, '--from', source.checkout, '--check');
    expect(result.status).toBe(0);
    expect(result.output).toContain(`sync-kit.mjs: the vendored kit files match ${source.second}`);
    expect(snapshot(game)).toEqual(before);
  });

  it('passes for an older commit that origin/main holds, not only for its head', () => {
    const game = gameWithPin(source.first, ALL_THREE.slice(0, 2));
    expect(run(game, '--from', source.checkout).status).toBe(0);
    expect(run(game, '--from', source.checkout, '--check').status).toBe(0);
  });

  it('exits 1 for a commit on a side branch only, though every file matches, and says to fetch', () => {
    const game = syncedGame(source.side);
    const before = snapshot(game);

    const result = run(game, '--from', source.checkout, '--check');
    expect(result.status).toBe(1);
    const mainHead = git(source.checkout, 'rev-parse', '--short', 'origin/main');
    expect(result.output.trimEnd()).toBe(
      `sync-kit.mjs: ${source.side} is not on origin/main of ${source.checkout} (origin/main there is ${mainHead}). ` +
        'Fetch that checkout and try again; if it still fails, the kit change has not merged.',
    );
    expect(result.output).not.toContain('match');
    expect(snapshot(game)).toEqual(before);
  });

  it('exits 1 and names the file when a file differs from the pinned commit, even if its recorded hash was edited to agree', () => {
    const game = syncedGame(source.second);
    writeFiles(game, { 'kit/actions.ts': 'edited by hand\n' });
    const pin = readPin(game);
    const editedHash = createHash('sha256').update('edited by hand\n').digest('hex');
    writeFileSync(join(game, 'kit', 'KIT_SOURCE.json'), `${JSON.stringify({ ...pin, sha256: { ...pin.sha256, 'kit/actions.ts': editedHash } }, null, 2)}\n`);
    expect(run(game, '--check').status).toBe(0);

    const result = run(game, '--from', source.checkout, '--check');
    expect(result.status).toBe(1);
    expect(result.output).toContain(`sync-kit.mjs: FAILED: these files differ from ${source.second}:`);
    expect(result.output).toContain('  kit/actions.ts\n');
    expect(result.output).not.toContain('kit/clock.ts');
    expect(readFileSync(join(game, 'kit/actions.ts'), 'utf8')).toBe('edited by hand\n');
  });
});

describe('sync-kit.mjs when it cannot tell: exit 2, one line, nothing written', () => {
  it('exits 2 with one line when the checkout has no origin/main, for --from, with nothing written', () => {
    const game = gameWithPin(sourceWithoutMain.second);
    const before = snapshot(game);

    const result = run(game, '--from', sourceWithoutMain.checkout);
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe(`sync-kit.mjs: ${sourceWithoutMain.checkout} has no origin/main to compare with. Is it a clone of game-kit?`);
    expect(snapshot(game)).toEqual(before);
    expect(existsSync(join(game, 'kit', 'clock.ts'))).toBe(false);
  });

  it('exits 2 with one line when the checkout has no origin/main, for --from --check, with nothing written', () => {
    const game = gameWithPin(sourceWithoutMain.second);
    const before = snapshot(game);

    const result = run(game, '--from', sourceWithoutMain.checkout, '--check');
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe(`sync-kit.mjs: ${sourceWithoutMain.checkout} has no origin/main to compare with. Is it a clone of game-kit?`);
    expect(snapshot(game)).toEqual(before);
  });

  it('exits 2 with one line when the checkout lacks the pinned commit, or is not a git checkout at all', () => {
    const game = gameWithPin(ABSENT_COMMIT);
    const before = snapshot(game);
    const notACheckout = temporaryFolder();

    for (const [checkout, options] of [
      [source.checkout, []],
      [source.checkout, ['--check']],
      [notACheckout, []],
    ] as const) {
      const result = run(game, '--from', checkout, ...options);
      expect(result.status).toBe(2);
      expect(result.output.trimEnd()).toBe(`sync-kit.mjs: ${ABSENT_COMMIT} is not in ${checkout}. Is that a game-kit checkout, and has it been fetched?`);
    }
    expect(snapshot(game)).toEqual(before);
  });

  it('exits 2 with one line when the pinned commit lacks one copies entry, leaving every game file and the pin byte-identical', () => {
    // A game synced at `second`, then re-pinned to `first`, which holds an older
    // kit/clock.ts and no tools/sync-kit.mjs. Copying kit/ before noticing the
    // missing entry would change kit/clock.ts.
    const game = syncedGame(source.second);
    const pinPath = join(game, 'kit', 'KIT_SOURCE.json');
    writeFileSync(pinPath, `${JSON.stringify({ ...readPin(game), commit: source.first }, null, 2)}\n`);
    const before = snapshot(game);

    for (const options of [[], ['--check']]) {
      const result = run(game, '--from', source.checkout, ...options);
      expect(result.status).toBe(2);
      expect(result.output.trimEnd()).toBe(`sync-kit.mjs: tools/sync-kit.mjs does not exist at ${source.first}`);
    }
    expect(snapshot(game)).toEqual(before);
    expect(readFileSync(join(game, 'kit/clock.ts'), 'utf8')).toBe('export const clock = 2;\n');

    // The same from an empty game: no file appears.
    const emptyGame = gameWithPin(source.first);
    const emptyBefore = snapshot(emptyGame);
    expect(run(emptyGame, '--from', source.checkout).status).toBe(2);
    expect(snapshot(emptyGame)).toEqual(emptyBefore);
  });

  it('exits 2 with one line when the pin names a branch or a short hash in place of a full commit', () => {
    for (const commit of ['origin/main', source.second.slice(0, 7)]) {
      const game = gameWithPin(commit);
      const before = snapshot(game);
      const result = run(game, '--from', source.checkout);
      expect(result.status).toBe(2);
      expect(result.output).toContain('"commit" must be a full commit hash');
      expect(snapshot(game)).toEqual(before);
    }
  });

  it('exits 2 with one line when given neither --from nor --check, or --from with no path', () => {
    const game = syncedGame(source.second);
    for (const options of [[], ['--from'], ['--from', '--check']]) {
      const result = run(game, ...options);
      expect(result.status).toBe(2);
      expect(result.output).toContain('pass --from <path to a game-kit checkout>');
    }
  });
});

describe('the files under tools/', () => {
  it('name no game', () => {
    // The names are assembled here so that this file passes its own test.
    const gameNames = [['ceme', 'tery'], ['into', '-the-dark'], ['into ', 'the dark']].map((parts) => parts.join(''));
    for (const file of readdirSync(TOOLS_DIRECTORY)) {
      const text = readFileSync(join(TOOLS_DIRECTORY, file), 'utf8').toLowerCase();
      for (const name of gameNames) {
        expect(text.includes(name), `${file} names "${name}"`).toBe(false);
      }
    }
  });
});
