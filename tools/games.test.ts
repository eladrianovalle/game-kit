// The games check's test. games.json is read from this repo; everything else
// is built in temp folders: a tiny game-kit source repo with an origin/main,
// and tiny games that hold a pin and a copy of this repo's tools/sync-kit.mjs.
// The workflow file is read as text, and its token guard is run in a shell.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CannotTell, GAMES_FILE, pinPath, readGames, setPinCommit, tryKitInGame } from './games.mjs';

const TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_DIRECTORY = join(TOOLS_DIRECTORY, '..');
const GAMES_SCRIPT = join(TOOLS_DIRECTORY, 'games.mjs');
const SYNC_SCRIPT = join(TOOLS_DIRECTORY, 'sync-kit.mjs');
const WORKFLOW_FILE = join(REPO_DIRECTORY, '.github', 'workflows', 'games.yml');
const ABSENT_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const KIT_AND_TESTING = [
  { from: 'kit', to: 'kit' },
  { from: 'testing', to: 'testing' },
];

interface Source {
  checkout: string;
  older: string;
  underTest: string;
}

const temporaryFolders: string[] = [];
let source: Source;

function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'games-'));
  temporaryFolders.push(folder);
  return folder;
}

function git(checkout: string, ...commandLine: string[]): string {
  const identity = ['-c', 'user.name=Games Test', '-c', 'user.email=games-test@example.invalid', '-c', 'commit.gpgsign=false'];
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

/** A game-kit source repo: `older` is on origin/main; `underTest`, the change a pull request would bring, is on no branch origin/main holds. */
function buildSource(): Source {
  const checkout = temporaryFolder();
  git(checkout, 'init', '-q');
  const older = commitAll(checkout, 'older', {
    'kit/actions.ts': 'export const actions = 1;\n',
    'kit/clock.ts': 'export const clock = 1;\n',
    'testing/fake-time.ts': 'export const fakeTime = 1;\n',
  });
  git(checkout, 'update-ref', 'refs/remotes/origin/main', older);
  const underTest = commitAll(checkout, 'the kit change under test', {
    'kit/clock.ts': 'export const clock = 2;\n',
    'kit/screens.ts': 'export const screens = 1;\n',
    'testing/fake-time.ts': 'export const fakeTime = 2;\n',
  });
  return { checkout, older, underTest };
}

/** A pin as a game holds one, keys in an order JSON.stringify would not choose for itself. */
function pinText(commit: string): string {
  const pin = {
    repository: 'game-kit, for people only',
    sha256: { 'kit/actions.ts': 'a'.repeat(64), 'kit/clock.ts': 'b'.repeat(64) },
    commit,
    copies: KIT_AND_TESTING,
    note: 'a key the tool does not know',
  };
  return `${JSON.stringify(pin, null, 2)}\n`;
}

/** A game checkout whose kit lives under `root`, synced at `older`, with its own copy of this repo's sync tool. */
function gameSyncedAtOlder(root: string): string {
  const game = temporaryFolder();
  const gameRoot = join(game, root);
  writeFiles(gameRoot, { 'kit/KIT_SOURCE.json': `${JSON.stringify({ repository: 'game-kit', commit: source.older, copies: KIT_AND_TESTING }, null, 2)}\n` });
  mkdirSync(join(gameRoot, 'tools'), { recursive: true });
  copyFileSync(SYNC_SCRIPT, join(gameRoot, 'tools', 'sync-kit.mjs'));
  const sync = spawnSync(process.execPath, ['tools/sync-kit.mjs', '--from', source.checkout], { cwd: gameRoot, encoding: 'utf8' });
  expect(sync.status, sync.stderr).toBe(0);
  return game;
}

/** Runs games.mjs as the workflow does. Holds, for every case, that nothing looks like a stack trace and that its own exit 2 prints one line. */
function run(...commandLine: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [GAMES_SCRIPT, ...commandLine], { encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  expect(output).not.toMatch(/^\s+at .+:\d+/m);
  expect(output).not.toMatch(/node:internal|file:\/\/|\bfatal:/);
  if (result.status === 2 && output.startsWith('games.mjs: ')) {
    expect(output.trimEnd().split('\n')).toHaveLength(1);
  }
  return { status: result.status, output };
}

function gamesFile(games: unknown): string {
  const file = join(temporaryFolder(), 'games.json');
  writeFileSync(file, JSON.stringify(games));
  return file;
}

beforeAll(() => {
  source = buildSource();
});

afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('games.json: the list of games', () => {
  it('lists exactly the games the spec shows, in its order', () => {
    // The spec's block is the source of truth; reading it here keeps game names out of tools/.
    const spec = readFileSync(join(REPO_DIRECTORY, 'specs', 'game-kit.md'), 'utf8');
    const block = /\*\*`games\.json`\*\*[^\n]*\n\n```json\n([\s\S]*?)```/.exec(spec);
    expect(block).not.toBeNull();
    expect(readGames()).toEqual(JSON.parse(block?.[1] ?? 'null'));
    expect(readGames()).toHaveLength(2);
    expect(GAMES_FILE).toBe(join(REPO_DIRECTORY, 'games.json'));
  });

  it('matrix prints games.json as one line of JSON for the workflow', () => {
    const result = run('matrix');
    expect(result.status).toBe(0);
    expect(result.output.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.output)).toEqual(readGames());
  });

  it.each(['repo', 'branch', 'root', 'merge'])('fails with one line, exit 2, on an entry missing "%s"', (field) => {
    const games = [
      { repo: 'owner/first', branch: 'main', root: '.', merge: 'merge' },
      { repo: 'owner/second', branch: 'dev', root: 'web', merge: 'squash' },
    ];
    delete (games[1] as Record<string, string>)[field];
    const file = gamesFile(games);

    expect(() => readGames(file)).toThrow(CannotTell);
    const result = run('matrix', '--games', file);
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe(`games.mjs: ${file}: game 2 has no "${field}"`);
  });

  it('fails with one line, exit 2, on an empty field, a list that is not a list, and a file that is not JSON', () => {
    const emptyRoot = gamesFile([{ repo: 'owner/first', branch: 'main', root: '', merge: 'merge' }]);
    expect(run('matrix', '--games', emptyRoot).output.trimEnd()).toBe(`games.mjs: ${emptyRoot}: game 1 has no "root"`);

    for (const contents of [{ repo: 'owner/first' }, []]) {
      const file = gamesFile(contents);
      const result = run('matrix', '--games', file);
      expect(result.status).toBe(2);
      expect(result.output.trimEnd()).toBe(`games.mjs: ${file} must be a list of games`);
    }

    const notJson = join(temporaryFolder(), 'games.json');
    writeFileSync(notJson, '[ not json');
    const result = run('matrix', '--games', notJson);
    expect(result.status).toBe(2);
    expect(result.output).toContain(`games.mjs: cannot read ${notJson}: `);
  });
});

describe('setPinCommit: move a game pin to a commit', () => {
  it('sets "commit" to the given hash and leaves every other key, its value and the key order as they were', () => {
    const gameRoot = temporaryFolder();
    writeFiles(gameRoot, { 'kit/KIT_SOURCE.json': pinText(source.older) });
    const before = JSON.parse(readFileSync(pinPath(gameRoot), 'utf8'));

    setPinCommit(gameRoot, source.underTest);

    const text = readFileSync(pinPath(gameRoot), 'utf8');
    // Byte for byte the old pin with only the hash swapped.
    expect(text).toBe(pinText(source.underTest));
    const after = JSON.parse(text);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect({ ...after, commit: undefined }).toEqual({ ...before, commit: undefined });
    expect(after.commit).toBe(source.underTest);
  });

  it('refuses a short hash or a branch name, and leaves the pin as it was', () => {
    const gameRoot = temporaryFolder();
    writeFiles(gameRoot, { 'kit/KIT_SOURCE.json': pinText(source.older) });
    for (const commit of [source.underTest.slice(0, 7), 'origin/main']) {
      expect(() => setPinCommit(gameRoot, commit)).toThrow('must be a full commit hash');
    }
    expect(readFileSync(pinPath(gameRoot), 'utf8')).toBe(pinText(source.older));
  });

  it('fails with a CannotTell naming the pin path when the game has no pin', () => {
    const gameRoot = temporaryFolder();
    expect(() => setPinCommit(gameRoot, source.underTest)).toThrow(CannotTell);
    expect(() => setPinCommit(gameRoot, source.underTest)).toThrow(`${pinPath(gameRoot)} does not exist`);
  });
});

describe('games.mjs try: the games check steps, against a tiny game-kit and a tiny game', () => {
  it('sets the pin to the commit under test and runs the game\'s own sync tool, so the game holds the source\'s files', () => {
    const game = gameSyncedAtOlder('web');
    const gameRoot = join(game, 'web');
    expect(readFileSync(join(gameRoot, 'kit/clock.ts'), 'utf8')).toBe('export const clock = 1;\n');
    expect(existsSync(join(gameRoot, 'kit/screens.ts'))).toBe(false);

    const result = run('try', '--game', game, '--root', 'web', '--commit', source.underTest, '--from', source.checkout);

    expect(result.status).toBe(0);
    // The game's own tool spoke: it copied, and noted the commit is not yet on main, as a pull request's is not.
    expect(result.output).toContain(`sync-kit.mjs: copied 3 file(s) from ${source.underTest}`);
    expect(result.output).toContain(`sync-kit.mjs: note: ${source.underTest} is not on origin/main`);
    for (const file of ['kit/actions.ts', 'kit/clock.ts', 'kit/screens.ts', 'testing/fake-time.ts']) {
      expect(readFileSync(join(gameRoot, file), 'utf8')).toBe(git(source.checkout, 'show', `${source.underTest}:${file}`) + '\n');
    }
    const pin = JSON.parse(readFileSync(pinPath(gameRoot), 'utf8'));
    expect(pin.commit).toBe(source.underTest);
    expect(Object.keys(pin.sha256)).toEqual(['kit/actions.ts', 'kit/clock.ts', 'kit/screens.ts', 'testing/fake-time.ts']);
    // The game's own check now passes on the copy, as `npm run check` will run it.
    const check = spawnSync(process.execPath, ['tools/sync-kit.mjs', '--check'], { cwd: gameRoot, encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
  });

  it('works for a game whose root is the checkout itself, called as a function', () => {
    const game = gameSyncedAtOlder('.');
    expect(tryKitInGame({ game, root: '.', commit: source.underTest, from: source.checkout })).toBe(0);
    expect(readFileSync(join(game, 'kit/screens.ts'), 'utf8')).toBe('export const screens = 1;\n');
  });

  it('passes the sync tool\'s exit code through when the sync fails', () => {
    const game = gameSyncedAtOlder('web');
    const result = run('try', '--game', game, '--root', 'web', '--commit', ABSENT_COMMIT, '--from', source.checkout);
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe(`sync-kit.mjs: ${ABSENT_COMMIT} is not in ${source.checkout}. Is that a game-kit checkout, and has it been fetched?`);
  });

  it('fails with one line, exit 2, for a game lacking a pin file, and writes nothing', () => {
    const game = temporaryFolder();
    writeFiles(game, { 'web/package.json': '{}\n' });
    const result = run('try', '--game', game, '--root', 'web', '--commit', source.underTest, '--from', source.checkout);
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe(
      `games.mjs: ${join(game, 'web', 'kit', 'KIT_SOURCE.json')} does not exist: this game has no kit pin, so the kit cannot be tried in it`,
    );
    expect(existsSync(join(game, 'web', 'kit'))).toBe(false);
  });

  it('fails with one line, exit 2, for a game lacking its own sync tool', () => {
    const game = temporaryFolder();
    writeFiles(game, { 'kit/KIT_SOURCE.json': pinText(source.older) });
    const result = run('try', '--game', game, '--root', '.', '--commit', source.underTest, '--from', source.checkout);
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe(`games.mjs: ${join(game, 'tools', 'sync-kit.mjs')} does not exist: this game has no sync tool to copy the kit with`);
  });

  it('fails with one line, exit 2, when an option is missing or the command is unknown', () => {
    const missingFrom = run('try', '--game', '.', '--root', '.', '--commit', source.underTest);
    expect(missingFrom.status).toBe(2);
    expect(missingFrom.output).toContain('games.mjs: try needs --from <value>.');
    for (const commandLine of [[], ['bump']]) {
      const result = run(...commandLine);
      expect(result.status).toBe(2);
      expect(result.output).toContain('games.mjs: pass a command');
    }
  });
});

describe('.github/workflows/games.yml', () => {
  const workflow = readFileSync(WORKFLOW_FILE, 'utf8');

  /** The `run: |` block of the step with this name, unindented. */
  function stepScript(stepName: string): string {
    const lines = workflow.split('\n');
    const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
    const runLine = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
    const indent = lines[runLine + 1].length - lines[runLine + 1].trimStart().length;
    const body: string[] = [];
    for (const line of lines.slice(runLine + 1)) {
      if (line.trim() !== '' && line.length - line.trimStart().length < indent) {
        break;
      }
      body.push(line.slice(indent));
    }
    return body.join('\n');
  }

  it('runs on pull requests to main, once per game from games.json, and one failure does not cancel the others', () => {
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}branches: \[main\]\n\n/m);
    expect(workflow).toContain('run: echo "games=$(node tools/games.mjs matrix)" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('game: ${{ fromJSON(needs.games.outputs.games) }}');
    expect(workflow).toContain('fail-fast: false');
  });

  it('checks out game-kit at the merge commit with full history, and the game at its branch with the token', () => {
    expect(workflow).toMatch(/ref: \$\{\{ github\.sha \}\}\n\s+fetch-depth: 0\n/);
    expect(workflow).toMatch(
      /repository: \$\{\{ matrix\.game\.repo \}\}\n\s+ref: \$\{\{ matrix\.game\.branch \}\}\n\s+token: \$\{\{ secrets\.KIT_GAMES_TOKEN \}\}\n\s+path: game\n/,
    );
  });

  it('runs the games check steps, then npm ci and npm run check in the game root, in that order', () => {
    const tryStep = workflow.indexOf('run: node tools/games.mjs try --game game --root "$GAME_ROOT_IN_CHECKOUT" --commit "$GITHUB_SHA" --from .');
    const install = workflow.indexOf('- run: npm ci\n        working-directory: ${{ env.GAME_ROOT }}');
    const check = workflow.indexOf('- run: npm run check\n        working-directory: ${{ env.GAME_ROOT }}');
    expect(tryStep).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(tryStep);
    expect(check).toBeGreaterThan(install);
    expect(workflow).toContain('GAME_ROOT: game/${{ matrix.game.root }}');
  });

  it('checks the token before any checkout, and fails with one line naming KIT_GAMES_TOKEN when it is empty', () => {
    const guardName = 'Require the KIT_GAMES_TOKEN secret';
    const checkJob = workflow.slice(workflow.indexOf('\n  check:\n'));
    expect(checkJob.indexOf(guardName)).toBeGreaterThan(-1);
    expect(checkJob.indexOf(guardName)).toBeLessThan(checkJob.indexOf('actions/checkout'));
    const script = stepScript(guardName);

    const empty = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, KIT_GAMES_TOKEN: '' } });
    expect(empty.status).toBe(1);
    const output = empty.stdout + empty.stderr;
    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(output).toContain('KIT_GAMES_TOKEN');

    const set = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, KIT_GAMES_TOKEN: 'a token' } });
    expect(set.status).toBe(0);
    expect(set.stdout + set.stderr).toBe('');
  });
});
