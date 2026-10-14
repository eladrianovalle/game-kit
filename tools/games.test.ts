// The games check's test. games.json is read from this repo; everything else
// is built in temp folders: a tiny game-kit source repo with an origin/main,
// and tiny games that hold a pin and a copy of this repo's tools/sync-kit.mjs.
// The workflow file is read as text, and its token guard is run in a shell.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CannotTell, GAMES_FILE, checksVerdict, decide, mergedPullRequest, pinPath, readGames, setPinCommit, waitForChecks } from './games.mjs';

const TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_DIRECTORY = join(TOOLS_DIRECTORY, '..');
const GAMES_SCRIPT = join(TOOLS_DIRECTORY, 'games.mjs');
const SYNC_SCRIPT = join(TOOLS_DIRECTORY, 'sync-kit.mjs');
const WORKFLOW_FILE = join(REPO_DIRECTORY, '.github', 'workflows', 'games.yml');
const BUMP_WORKFLOW_FILE = join(REPO_DIRECTORY, '.github', 'workflows', 'bump.yml');
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
  return runWith({}, ...commandLine);
}

/** `run`, with extra environment: a git identity for the bot's commits, and a fake `gh` first on the PATH. */
function runWith(env: Record<string, string>, ...commandLine: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [GAMES_SCRIPT, ...commandLine], { encoding: 'utf8', env: { ...process.env, ...env } });
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

  it('works for a game whose root is the checkout itself', () => {
    const game = gameSyncedAtOlder('.');
    expect(run('try', '--game', game, '--root', '.', '--commit', source.underTest, '--from', source.checkout).status).toBe(0);
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

/** The `run: |` block of the step with this name, unindented. */
function stepScript(workflow: string, stepName: string): string {
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

describe('.github/workflows/games.yml', () => {
  const workflow = readFileSync(WORKFLOW_FILE, 'utf8');

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
    const script = stepScript(workflow, guardName);

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

// ---------------------------------------------------------------------------
// The bot.

const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Bot Test',
  GIT_AUTHOR_EMAIL: 'bot-test@example.invalid',
  GIT_COMMITTER_NAME: 'Bot Test',
  GIT_COMMITTER_EMAIL: 'bot-test@example.invalid',
};

/** A merged kit pull request as `decide` takes it. */
function kitPull(title: string, files: string[], labels: string[] = []): { title: string; labels: string[]; files: string[] } {
  return { title, labels, files };
}

describe('decide: hold for the owner, or merge each pin move when green', () => {
  it('holds when no pull request was found (a direct push to main), and says so', () => {
    const decision = decide({ pr: null });
    expect(decision.action).toBe('hold');
    expect(decision.reason).toContain('No merged pull request was found');
  });

  it('holds a pull request whose title starts BREAKING:, and says so', () => {
    const decision = decide({ pr: kitPull('BREAKING: screens take a scroll target', ['kit/clock.ts'], ['additive']) });
    expect(decision.action).toBe('hold');
    expect(decision.reason).toContain('"BREAKING:"');
  });

  it.each(['kit/screens.ts', 'kit/page.ts'])('holds a change to %s without the additive label, naming the file and the label', (file) => {
    const decision = decide({ pr: kitPull('Screens: scroll only when needed', [file, 'kit/clock.ts'], ['enhancement']) });
    expect(decision.action).toBe('hold');
    expect(decision.reason).toContain(file);
    expect(decision.reason).toContain('"additive" label');
  });

  it.each(['kit/screens.ts', 'kit/page.ts'])('merges when green a change to %s that carries the additive label', (file) => {
    expect(decide({ pr: kitPull('Screens: an optional scroll target', [file], ['additive']) })).toEqual({ action: 'merge-when-green' });
  });

  it('merges when green a change to kit/screens.test.ts alone: a test file is not the browser-only file', () => {
    expect(decide({ pr: kitPull('Screens: one more test', ['kit/screens.test.ts']) })).toEqual({ action: 'merge-when-green' });
  });

  it('merges when green any other change', () => {
    expect(decide({ pr: kitPull('Clock: a pause method', ['kit/clock.ts', 'kit/clock.test.ts', 'README.md']) })).toEqual({ action: 'merge-when-green' });
    expect(decide({ pr: kitPull('Docs only', []) })).toEqual({ action: 'merge-when-green' });
  });

  it('gives each hold its own one-sentence reason', () => {
    const reasons = [
      decide({ pr: null }),
      decide({ pr: kitPull('BREAKING: x', []) }),
      decide({ pr: kitPull('x', ['kit/page.ts']) }),
    ].map((decision) => decision.reason ?? '');
    expect(new Set(reasons).size).toBe(3);
    for (const reason of reasons) {
      expect(reason).toMatch(/^[A-Z].*\.$/);
      expect(reason.match(/\.(\s|$)/g)).toHaveLength(1);
    }
  });
});

describe('games.mjs merged-pull and decide: from what GitHub returns for the pushed commit', () => {
  const sha = 'a'.repeat(40);
  const merged = { number: 12, html_url: 'https://github.com/owner/game-kit/pull/12', title: 'Screens: a scroll target', merge_commit_sha: sha, merged_at: '2026-10-14T10:00:00Z', labels: [{ name: 'additive' }] };
  const other = { number: 9, html_url: 'https://github.com/owner/game-kit/pull/9', title: 'An older one', merge_commit_sha: 'b'.repeat(40), merged_at: '2026-10-01T10:00:00Z', labels: [] };

  function files(folder: string, pulls: unknown, changed: string[]): { pulls: string; files: string } {
    writeFileSync(join(folder, 'pulls.json'), JSON.stringify(pulls));
    writeFileSync(join(folder, 'files.txt'), changed.map((file) => `${file}\n`).join(''));
    return { pulls: join(folder, 'pulls.json'), files: join(folder, 'files.txt') };
  }

  it('finds the pull request whose merge commit is the pushed commit, and nothing for a direct push', () => {
    expect(mergedPullRequest([other, merged], sha)).toBe(merged);
    expect(mergedPullRequest([other], sha)).toBeNull();
    expect(mergedPullRequest([], sha)).toBeNull();

    const folder = temporaryFolder();
    const found = files(folder, [other, merged], []);
    expect(run('merged-pull', '--pulls', found.pulls, '--sha', sha)).toEqual({ status: 0, output: '12\n' });
    const none = files(temporaryFolder(), [], []);
    expect(run('merged-pull', '--pulls', none.pulls, '--sha', sha)).toEqual({ status: 0, output: '' });
  });

  it('decides from the title, label names and changed files, and appends the decision to the output file', () => {
    const folder = temporaryFolder();
    const input = files(folder, [merged], ['kit/screens.ts', 'kit/screens.test.ts']);
    const output = join(folder, 'github-output');

    const result = run('decide', '--pulls', input.pulls, '--sha', sha, '--files', input.files, '--output', output);

    expect(result.status).toBe(0);
    const decision = JSON.parse(result.output);
    expect(decision.action).toBe('merge-when-green');
    expect(decision.reason).toContain('additive');
    expect(decision.pullRequest).toEqual({ number: 12, url: merged.html_url, title: merged.title });
    expect(readFileSync(output, 'utf8')).toBe(`decision=${result.output}`);
  });

  it('holds without the label, and holds a direct push with no pull request named', () => {
    const unlabelled = files(temporaryFolder(), [{ ...merged, labels: [{ name: 'enhancement' }] }], ['kit/screens.ts']);
    const held = JSON.parse(run('decide', '--pulls', unlabelled.pulls, '--sha', sha, '--files', unlabelled.files).output);
    expect(held.action).toBe('hold');
    expect(held.reason).toContain('kit/screens.ts');

    const direct = files(temporaryFolder(), [], []);
    const pushed = JSON.parse(run('decide', '--pulls', direct.pulls, '--sha', sha, '--files', direct.files).output);
    expect(pushed).toEqual({ action: 'hold', reason: decide({ pr: null }).reason, pullRequest: null });
  });
});

/** A game repo on branch `dev`, its kit under `root` synced at `older` and committed, with a file outside the kit. */
function gameRepoSyncedAtOlder(root: string): string {
  const game = gameSyncedAtOlder(root);
  writeFiles(game, { 'README.md': 'a game\n', [join(root, 'src/main.ts')]: 'export {};\n' });
  git(game, 'init', '-q', '-b', 'dev');
  git(game, 'add', '-A');
  git(game, 'commit', '-q', '-m', 'the game, synced at older');
  return game;
}

function filesInCommit(game: string, commit: string): string[] {
  return git(game, 'show', '--name-only', '--format=', commit).split('\n').filter((line) => line.length > 0).sort();
}

describe('games.mjs move-pin: one game\'s pin move, in a temp game repo', () => {
  it('commits only the pin and the files the sync wrote, on kit/<short hash>, and leaves unrelated work uncommitted', () => {
    const game = gameRepoSyncedAtOlder('web');
    const before = git(game, 'rev-parse', 'HEAD');
    // Work in the game the bot must not commit: an untracked file, and an edit to a tracked file outside the kit.
    writeFiles(game, { 'scratch.txt': 'not for the kit\n', 'web/src/notes.ts': 'export const notes = 1;\n', 'README.md': 'a game, edited\n' });
    const output = join(temporaryFolder(), 'github-output');

    const result = runWith(BOT_IDENTITY, 'move-pin', '--game', game, '--root', 'web', '--commit', source.underTest, '--from', source.checkout, '--output', output);

    expect(result.status).toBe(0);
    const branch = `kit/${source.underTest.slice(0, 12)}`;
    expect(result.output).toContain(`games.mjs: moved the pin to ${source.underTest} on ${branch}, committing 4 file(s)`);
    expect(git(game, 'branch', '--show-current')).toBe(branch);
    expect(git(game, 'rev-parse', 'HEAD~1')).toBe(before);
    // kit/actions.ts was rewritten with the same bytes, so it is not in the commit.
    expect(filesInCommit(game, 'HEAD')).toEqual(['web/kit/KIT_SOURCE.json', 'web/kit/clock.ts', 'web/kit/screens.ts', 'web/testing/fake-time.ts']);
    expect(git(game, 'log', '-1', '--format=%B')).toContain(`Copies game-kit ${source.underTest}`);
    expect(JSON.parse(git(game, 'show', 'HEAD:web/kit/KIT_SOURCE.json')).commit).toBe(source.underTest);
    // (git() trims, so the first line loses its leading space.)
    expect(git(game, 'status', '--porcelain', '--untracked-files=all').split('\n').map((line) => line.trim()).sort()).toEqual(['?? scratch.txt', '?? web/src/notes.ts', 'M README.md']);
    expect(readFileSync(output, 'utf8')).toBe(`moved=true\nbranch=${branch}\nskipped=\n`);
  });

  it('works for a game whose root is the checkout itself', () => {
    const game = gameRepoSyncedAtOlder('.');
    const result = runWith(BOT_IDENTITY, 'move-pin', '--game', game, '--root', '.', '--commit', source.underTest, '--from', source.checkout);
    expect(result.status).toBe(0);
    expect(filesInCommit(game, 'HEAD')).toEqual(['kit/KIT_SOURCE.json', 'kit/clock.ts', 'kit/screens.ts', 'testing/fake-time.ts']);
  });

  it('does nothing for a game whose pin already names the commit: no branch, no commit, one line', () => {
    const game = gameRepoSyncedAtOlder('web');
    const before = git(game, 'rev-parse', 'HEAD');
    const output = join(temporaryFolder(), 'github-output');

    const result = runWith(BOT_IDENTITY, 'move-pin', '--game', game, '--root', 'web', '--commit', source.older, '--from', source.checkout, '--output', output);

    expect(result.status).toBe(0);
    expect(result.output).toBe(`games.mjs: the pin already names ${source.older}; nothing to do\n`);
    expect(git(game, 'branch', '--show-current')).toBe('dev');
    expect(git(game, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(game, 'status', '--porcelain')).toBe('');
    expect(readFileSync(output, 'utf8')).toBe('moved=false\nskipped=\n');
  });

  it('skips a game with no pin file: one line, exit 0, a line on the summary, and nothing changed', () => {
    const game = temporaryFolder();
    writeFiles(game, { 'web/package.json': '{}\n' });
    git(game, 'init', '-q', '-b', 'dev');
    git(game, 'add', '-A');
    git(game, 'commit', '-q', '-m', 'a game with no pin');
    const folder = temporaryFolder();
    const output = join(folder, 'github-output');
    const summary = join(folder, 'summary.md');

    const result = runWith(BOT_IDENTITY, 'move-pin', '--game', game, '--root', 'web', '--commit', source.underTest, '--from', source.checkout, '--output', output, '--summary', summary);

    const line = `${join(game, 'web', 'kit', 'KIT_SOURCE.json')} does not exist: this game has no kit pin, so its pin cannot be moved`;
    expect(result).toEqual({ status: 0, output: `games.mjs: skipped: ${line}\n` });
    expect(readFileSync(summary, 'utf8')).toBe(`- skipped: ${line}\n`);
    expect(readFileSync(output, 'utf8')).toBe(`moved=false\nskipped=${line}\n`);
    expect(git(game, 'branch', '--show-current')).toBe('dev');
    expect(git(game, 'status', '--porcelain')).toBe('');
  });

  it('skips a game whose sync fails, and commits nothing', () => {
    const game = gameRepoSyncedAtOlder('web');
    const before = git(game, 'rev-parse', 'HEAD');
    const result = runWith(BOT_IDENTITY, 'move-pin', '--game', game, '--root', 'web', '--commit', ABSENT_COMMIT, '--from', source.checkout);
    expect(result.status).toBe(0);
    expect(result.output).toContain(`games.mjs: skipped: the game's sync tool exited 2 for ${ABSENT_COMMIT}; nothing was committed`);
    expect(git(game, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('runs the sync a second time when the kit brings a new sync tool, so the new tool does the copy', () => {
    // A source whose commit also carries a changed copy of the sync tool.
    const checkout = temporaryFolder();
    git(checkout, 'init', '-q');
    const tool = readFileSync(SYNC_SCRIPT, 'utf8');
    const older = commitAll(checkout, 'older', { 'kit/a.ts': 'export const a = 1;\n', 'tools/sync-kit.mjs': tool });
    git(checkout, 'update-ref', 'refs/remotes/origin/main', older);
    const newer = commitAll(checkout, 'newer', { 'kit/a.ts': 'export const a = 2;\n', 'tools/sync-kit.mjs': `${tool}// a newer tool\n` });
    const game = temporaryFolder();
    const copies = [...KIT_AND_TESTING.slice(0, 1), { from: 'tools/sync-kit.mjs', to: 'tools/sync-kit.mjs' }];
    writeFiles(game, { 'kit/KIT_SOURCE.json': `${JSON.stringify({ repository: 'game-kit', commit: older, copies }, null, 2)}\n`, 'tools/sync-kit.mjs': tool });
    expect(spawnSync(process.execPath, ['tools/sync-kit.mjs', '--from', checkout], { cwd: game }).status).toBe(0);
    git(game, 'init', '-q', '-b', 'main');
    git(game, 'add', '-A');
    git(game, 'commit', '-q', '-m', 'synced at older');

    const result = runWith(BOT_IDENTITY, 'move-pin', '--game', game, '--root', '.', '--commit', newer, '--from', checkout);

    expect(result.status).toBe(0);
    expect(result.output.match(/sync-kit\.mjs: copied \d+ file\(s\) from /g)).toHaveLength(2);
    expect(filesInCommit(game, 'HEAD')).toEqual(['kit/KIT_SOURCE.json', 'kit/a.ts', 'tools/sync-kit.mjs']);
    expect(spawnSync(process.execPath, ['tools/sync-kit.mjs', '--check'], { cwd: game }).status).toBe(0);
  });
});

// A fake `gh`: logs every call, and answers from a scenario file.
interface Scenario {
  open?: { number: number; url: string; headRefName: string; commits?: unknown[] }[];
  created?: string;
  views?: unknown[][];
  mergeFails?: boolean;
}

function fakeGh(scenario: Scenario): { env: Record<string, string>; calls: () => string[][] } {
  const folder = temporaryFolder();
  const bin = join(folder, 'bin');
  mkdirSync(bin);
  writeFileSync(join(folder, 'scenario.json'), JSON.stringify(scenario));
  const script = `#!${process.execPath}
const fs = require('node:fs');
const folder = ${JSON.stringify(folder)};
const scenario = JSON.parse(fs.readFileSync(folder + '/scenario.json', 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(folder + '/calls.jsonl', JSON.stringify(args) + '\\n');
const command = args.slice(0, 2).join(' ');
if (command === 'pr list') {
  process.stdout.write(JSON.stringify(scenario.open || []));
} else if (command === 'pr create') {
  process.stderr.write('Creating pull request\\n');
  process.stdout.write(scenario.created + '\\n');
} else if (command === 'pr view') {
  const counter = folder + '/views';
  const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(seen + 1));
  const views = scenario.views || [[]];
  process.stdout.write(JSON.stringify({ statusCheckRollup: views[Math.min(seen, views.length - 1)] }));
} else if (command === 'pr merge' && scenario.mergeFails) {
  process.stderr.write('Pull request is not mergeable: the base branch policy prohibits the merge.\\n');
  process.exit(1);
}
`;
  writeFileSync(join(bin, 'gh'), script);
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    env: { PATH: `${bin}:${process.env.PATH}` },
    calls: () => {
      const log = join(folder, 'calls.jsonl');
      return existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line)) : [];
    },
  };
}

const passed = (name: string) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const running = (name: string) => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '' });
const failedCheck = (name: string) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' });

const KIT_SHA = 'c'.repeat(40);
const MERGE_DECISION = { action: 'merge-when-green', reason: 'The kit pull request is additive.', pullRequest: { number: 12, url: 'https://github.com/owner/game-kit/pull/12', title: 'Clock: a pause method' } };
const HOLD_DECISION = { action: 'hold', reason: 'The kit pull request\'s title starts "BREAKING:".', pullRequest: { number: 13, url: 'https://github.com/owner/game-kit/pull/13', title: 'BREAKING: x' } };
const NEW_PULL = 'https://github.com/owner/game/pull/40';

describe('games.mjs open-pr: the pin-move pull request in a game', () => {
  it('opens it with the title, and a body naming the kit pull request, the decision and its reason, then closes older kit/* ones naming it', () => {
    const gh = fakeGh({
      created: NEW_PULL,
      open: [
        { number: 30, url: 'https://github.com/owner/game/pull/30', headRefName: 'kit/aaaaaaaaaaaa' },
        { number: 31, url: 'https://github.com/owner/game/pull/31', headRefName: 'feature/kit-menu' },
      ],
    });
    const output = join(temporaryFolder(), 'github-output');

    const result = runWith(gh.env, 'open-pr', '--repo', 'owner/game', '--base', 'dev', '--head', 'kit/cccccccccccc', '--commit', KIT_SHA, '--decision', JSON.stringify(MERGE_DECISION), '--kit-repo', 'owner/game-kit', '--output', output);

    expect(result).toEqual({ status: 0, output: `${NEW_PULL}\n` });
    expect(readFileSync(output, 'utf8')).toBe(`url=${NEW_PULL}\n`);
    const calls = gh.calls();
    const create = calls.find((call) => call[1] === 'create') ?? [];
    expect(create.slice(0, 10)).toEqual(['pr', 'create', '--repo', 'owner/game', '--base', 'dev', '--head', 'kit/cccccccccccc', '--title', 'Move the kit pin to game-kit cccccccccccc']);
    const body = create[create.indexOf('--body') + 1];
    expect(body).toContain('- Kit pull request: owner/game-kit#12 (Clock: a pause method)');
    expect(body).toContain('- Decision: merge when green');
    expect(body).toContain('- Reason: The kit pull request is additive.');
    // Only the older kit/* pull request is closed, after the new one exists, with a comment naming it.
    const closes = calls.filter((call) => call[1] === 'close');
    expect(closes).toHaveLength(1);
    expect(closes[0].slice(0, 5)).toEqual(['pr', 'close', 'https://github.com/owner/game/pull/30', '--repo', 'owner/game']);
    expect(closes[0][6]).toContain(`Replaced by ${NEW_PULL}`);
    expect(calls.indexOf(create)).toBeLessThan(calls.indexOf(closes[0]));
  });

  it('leaves open, with a comment, an older pin move that holds edits beyond the bot\'s commit', () => {
    const gh = fakeGh({
      created: NEW_PULL,
      open: [{ number: 30, url: 'https://github.com/owner/game/pull/30', headRefName: 'kit/aaaaaaaaaaaa', commits: [{}, {}] }],
    });
    runWith(gh.env, 'open-pr', '--repo', 'owner/game', '--base', 'dev', '--head', 'kit/cccccccccccc', '--commit', KIT_SHA, '--decision', JSON.stringify(HOLD_DECISION), '--kit-repo', 'owner/game-kit');
    const calls = gh.calls();
    expect(calls.filter((call) => call[1] === 'close')).toHaveLength(0);
    const comment = calls.find((call) => call[1] === 'comment') ?? [];
    expect(comment.slice(0, 5)).toEqual(['pr', 'comment', 'https://github.com/owner/game/pull/30', '--repo', 'owner/game']);
    expect(comment[6]).toContain(`carry them onto ${NEW_PULL}`);
  });

  it('names a hold and a direct push in the body', () => {
    const gh = fakeGh({ created: NEW_PULL });
    runWith(gh.env, 'open-pr', '--repo', 'owner/game', '--base', 'main', '--head', 'kit/cccccccccccc', '--commit', KIT_SHA, '--decision', JSON.stringify({ ...HOLD_DECISION, pullRequest: null }), '--kit-repo', 'owner/game-kit');
    const create = gh.calls().find((call) => call[1] === 'create') ?? [];
    const body = create[create.indexOf('--body') + 1];
    expect(body).toContain(`- Kit pull request: none: ${KIT_SHA} was pushed to owner/game-kit main directly`);
    expect(body).toContain('- Decision: hold for the owner');
  });

  it('reuses the open pull request from the same head instead of opening a second', () => {
    const gh = fakeGh({ open: [{ number: 40, url: NEW_PULL, headRefName: 'kit/cccccccccccc' }] });
    const result = runWith(gh.env, 'open-pr', '--repo', 'owner/game', '--base', 'dev', '--head', 'kit/cccccccccccc', '--commit', KIT_SHA, '--decision', JSON.stringify(MERGE_DECISION), '--kit-repo', 'owner/game-kit');
    expect(result.output).toBe(`${NEW_PULL}\n`);
    expect(gh.calls().map((call) => call[1])).toEqual(['list']);
  });
});

describe('checksVerdict and waitForChecks: at least one check, all passed, within the time', () => {
  it('waits on no checks and on running ones, fails on a failed one, and passes only when every check has', () => {
    expect(checksVerdict([])).toEqual({ state: 'waiting', reason: 'no check has reported' });
    expect(checksVerdict([passed('lint'), running('test')]).state).toBe('waiting');
    expect(checksVerdict([running('lint'), failedCheck('test')])).toEqual({ state: 'failed', reason: 'the check "test" ended failure' });
    expect(checksVerdict([passed('lint'), { ...passed('e2e'), conclusion: 'SKIPPED' }])).toEqual({ state: 'failed', reason: 'the check "e2e" ended skipped' });
    expect(checksVerdict([passed('lint'), passed('test')])).toEqual({ state: 'passed', reason: 'all 2 check(s) passed' });
    // Commit statuses, as other CI systems report them.
    expect(checksVerdict([{ __typename: 'StatusContext', context: 'ci/build', state: 'PENDING' }]).state).toBe('waiting');
    expect(checksVerdict([{ __typename: 'StatusContext', context: 'ci/build', state: 'ERROR' }]).reason).toBe('the check "ci/build" ended error');
    expect(checksVerdict([{ __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' }]).state).toBe('passed');
  });

  function clock(rollups: unknown[][]): { reads: () => number; wait: (timeoutMs: number) => ReturnType<typeof waitForChecks> } {
    let time = 0;
    let reads = 0;
    return {
      reads: () => reads,
      wait: (timeoutMs) =>
        waitForChecks({
          read: () => rollups[Math.min(reads++, rollups.length - 1)],
          sleep: (milliseconds: number) => {
            time += milliseconds;
          },
          now: () => time,
          timeoutMs,
          pollMs: 30_000,
        }),
    };
  }

  it('gives up after 30 minutes when no check ever reports', () => {
    const fake = clock([[]]);
    expect(fake.wait(30 * 60_000)).toEqual({ state: 'timed-out', reason: 'after 30 minute(s), no check has reported' });
    expect(fake.reads()).toBe(61);
  });

  it('does not take a pass seen once when a later check then registers', () => {
    const fake = clock([[passed('lint')], [passed('lint'), running('test')], [passed('lint'), failedCheck('test')]]);
    expect(fake.wait(30 * 60_000)).toEqual({ state: 'failed', reason: 'the check "test" ended failure' });
  });

  it('passes after two polls in a row see every check passed', () => {
    const fake = clock([[], [running('test')], [passed('test')], [passed('test')]]);
    expect(fake.wait(30 * 60_000).state).toBe('passed');
    expect(fake.reads()).toBe(4);
  });
});

describe('games.mjs finish: merge when green, or comment why it stays open', () => {
  // Each poll runs the fake gh, a Node start of its own, so time is generous except where it is meant to run out.
  function finish(gh: ReturnType<typeof fakeGh>, decision: unknown, ...extra: string[]): { status: number | null; output: string } {
    const timeout = extra.includes('--timeout-seconds') ? [] : ['--timeout-seconds', '20'];
    return runWith(gh.env, 'finish', '--repo', 'owner/game', '--pr', NEW_PULL, '--decision', JSON.stringify(decision), '--merge', 'squash', '--poll-seconds', '0.02', ...timeout, ...extra);
  }

  it('merges with the game\'s method and deletes the branch, only after at least one check reported and all passed', () => {
    const gh = fakeGh({ views: [[], [running('check')], [passed('check')], [passed('check')]] });
    const summary = join(temporaryFolder(), 'summary.md');

    const result = finish(gh, MERGE_DECISION, '--summary', summary);

    expect(result.status).toBe(0);
    expect(result.output).toBe(`games.mjs: merged ${NEW_PULL}: all 1 check(s) passed\n`);
    const calls = gh.calls();
    expect(calls.filter((call) => call[1] === 'view')).toHaveLength(4);
    expect(calls.at(-1)).toEqual(['pr', 'merge', NEW_PULL, '--repo', 'owner/game', '--squash', '--delete-branch']);
    expect(calls.some((call) => call[1] === 'comment')).toBe(false);
    expect(readFileSync(summary, 'utf8')).toBe(`- owner/game: merged ${NEW_PULL}: all 1 check(s) passed\n`);
  });

  it('on hold, only comments the reason and leaves it open', () => {
    const gh = fakeGh({ views: [[passed('check')]] });
    expect(finish(gh, HOLD_DECISION).status).toBe(0);
    const calls = gh.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 5)).toEqual(['pr', 'comment', NEW_PULL, '--repo', 'owner/game']);
    expect(calls[0][6]).toContain('Held for the owner');
    expect(calls[0][6]).toContain(HOLD_DECISION.reason);
  });

  it('when a check fails, comments which and does not merge', () => {
    const gh = fakeGh({ views: [[running('check')], [failedCheck('check')]] });
    expect(finish(gh, MERGE_DECISION).status).toBe(0);
    const calls = gh.calls();
    expect(calls.some((call) => call[1] === 'merge')).toBe(false);
    expect(calls.at(-1)?.[1]).toBe('comment');
    expect(calls.at(-1)?.[6]).toContain('Not merged by the bot: the check "check" ended failure');
  });

  it('when no check reports in time, comments that and does not merge', () => {
    const gh = fakeGh({ views: [[]] });
    const result = finish(gh, MERGE_DECISION, '--timeout-seconds', '0.3');
    expect(result.status).toBe(0);
    const calls = gh.calls();
    expect(calls.some((call) => call[1] === 'merge')).toBe(false);
    expect(calls.at(-1)?.[6]).toContain('no check has reported');
  });

  it('when the merge itself fails, comments why and exits 2 with one line', () => {
    const gh = fakeGh({ views: [[passed('check')]], mergeFails: true });
    const result = finish(gh, MERGE_DECISION);
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe('games.mjs: gh pr merge failed: Pull request is not mergeable: the base branch policy prohibits the merge.');
    expect(gh.calls().at(-1)?.[6]).toContain('the merge failed');
  });

  it('refuses a merge method games.json would not hold', () => {
    const gh = fakeGh({});
    const result = runWith(gh.env, 'finish', '--repo', 'owner/game', '--pr', NEW_PULL, '--decision', JSON.stringify(MERGE_DECISION), '--merge', 'fast-forward');
    expect(result.status).toBe(2);
    expect(result.output.trimEnd()).toBe('games.mjs: the merge method must be one of merge, squash, rebase, not "fast-forward"');
    expect(gh.calls()).toEqual([]);
  });
});

describe('.github/workflows/bump.yml', () => {
  const workflow = readFileSync(BUMP_WORKFLOW_FILE, 'utf8');

  it('runs on pushes to main, one run at a time, never cancelling one in progress', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n\n/m);
    expect(workflow).toMatch(/^concurrency:\n {2}group: kit-bump\n {2}cancel-in-progress: false\n/m);
  });

  it('checks the token first, and fails with one line naming KIT_GAMES_TOKEN when it is empty', () => {
    const guardName = 'Require the KIT_GAMES_TOKEN secret';
    expect(workflow.indexOf(guardName)).toBeGreaterThan(-1);
    expect(workflow.indexOf(guardName)).toBeLessThan(workflow.indexOf('actions/checkout'));
    const script = stepScript(workflow, guardName);
    const empty = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, KIT_GAMES_TOKEN: '' } });
    expect(empty.status).toBe(1);
    expect((empty.stdout + empty.stderr).trimEnd().split('\n')).toHaveLength(1);
    expect(empty.stdout + empty.stderr).toContain('KIT_GAMES_TOKEN');
  });

  it('finds the merged pull request and its changed files with gh api, and decides once with games.mjs', () => {
    const script = stepScript(workflow, 'Find the merged pull request and decide');
    expect(script).toContain('gh api "repos/${{ github.repository }}/commits/${{ github.sha }}/pulls"');
    expect(script).toContain('/files" --paginate');
    expect(script).toContain('node tools/games.mjs decide');
    expect(workflow).toContain('fetch-depth: 0');
  });

  it('moves each game in turn from games.json, and one game\'s failure does not stop another', () => {
    expect(workflow).toContain('run: echo "games=$(node tools/games.mjs matrix)" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('game: ${{ fromJSON(needs.decide.outputs.games) }}');
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('max-parallel: 1');
  });

  it('moves the pin, pushes, opens the pull request and finishes it, in that order, with the token and the game\'s merge method', () => {
    const steps = [
      'node tools/games.mjs move-pin --game game --root "$GAME_ROOT_IN_CHECKOUT" --commit "$GITHUB_SHA" --from . --output "$GITHUB_OUTPUT" --summary "$GITHUB_STEP_SUMMARY"',
      'git -C game push origin "$BRANCH"',
      'node tools/games.mjs open-pr --repo "$GAME" --base "$BASE" --head "$BRANCH" --commit "$GITHUB_SHA" --decision "$DECISION" --kit-repo "$GITHUB_REPOSITORY"',
      'node tools/games.mjs finish --repo "$GAME" --pr "$PULL" --decision "$DECISION" --merge "$MERGE" --timeout-seconds 1800',
    ].map((step) => workflow.indexOf(step));
    for (const [index, position] of steps.entries()) {
      expect(position).toBeGreaterThan(index === 0 ? -1 : steps[index - 1]);
    }
    expect(workflow).toContain('MERGE: ${{ matrix.game.merge }}');
    expect(workflow.match(/GH_TOKEN: \$\{\{ secrets\.KIT_GAMES_TOKEN \}\}/g)).toHaveLength(2);
    expect(workflow.match(/if: steps\.move\.outputs\.moved == 'true'/g)).toHaveLength(3);
    expect(workflow).toContain('token: ${{ secrets.KIT_GAMES_TOKEN }}');
  });
});
