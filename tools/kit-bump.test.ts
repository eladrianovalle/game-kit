// The bot's test. Everything is built in temp folders: a tiny game-kit with an
// origin/main, a tiny game with a pin, a copy of this repo's sync tool and a
// bare repo as its origin, and a fake `gh` that answers from a scenario file
// and logs every call. The game's workflow template is read as text.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { combine, decide, originAuthEnv, setPinCommit } from './kit-bump.mjs';

const TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_DIRECTORY = join(TOOLS_DIRECTORY, '..');
const BOT_SCRIPT = join(TOOLS_DIRECTORY, 'kit-bump.mjs');
const SYNC_SCRIPT = join(TOOLS_DIRECTORY, 'sync-kit.mjs');
const TEMPLATE_FILE = join(REPO_DIRECTORY, 'templates', 'kit-bump.yml');
const KIT_REPO = 'owner/game-kit';
const GAME_REPO = 'owner/game';
const NEW_PULL = 'https://github.com/owner/game/pull/40';

const temporaryFolders: string[] = [];

function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'kit-bump-'));
  temporaryFolders.push(folder);
  return folder;
}

afterAll(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

const IDENTITY = ['-c', 'user.name=Kit Bump Test', '-c', 'user.email=kit-bump-test@example.invalid', '-c', 'commit.gpgsign=false'];

function git(checkout: string, ...commandLine: string[]): string {
  return execFileSync('git', ['-C', checkout, ...IDENTITY, ...commandLine], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

interface Kit {
  checkout: string;
  older: string;
  head: string;
}

/** A game-kit whose main moved from `older` to `head` by one change. */
function buildKit(): Kit {
  const checkout = temporaryFolder();
  git(checkout, 'init', '-q');
  const older = commitAll(checkout, 'older', {
    'kit/actions.ts': 'export const actions = 1;\n',
    'kit/clock.ts': 'export const clock = 1;\n',
    'testing/fake-time.ts': 'export const fakeTime = 1;\n',
  });
  const head = commitAll(checkout, 'a kit change', {
    'kit/clock.ts': 'export const clock = 2;\n',
    'testing/fake-time.ts': 'export const fakeTime = 2;\n',
  });
  git(checkout, 'update-ref', 'refs/remotes/origin/main', head);
  return { checkout, older, head };
}

const KIT_AND_TESTING = [
  { from: 'kit', to: 'kit' },
  { from: 'testing', to: 'testing' },
];

/** A game whose kit lives under `root`, synced at the kit's older commit, committed, with a bare repo as origin. */
function buildGame(kit: Kit, root = '.', copies = KIT_AND_TESTING): string {
  const game = temporaryFolder();
  const gameRoot = join(game, root);
  git(game, 'init', '-q', '-b', 'main');
  writeFiles(gameRoot, { 'kit/KIT_SOURCE.json': `${JSON.stringify({ repository: 'game-kit', commit: kit.older, copies }, null, 2)}\n` });
  mkdirSync(join(gameRoot, 'tools'), { recursive: true });
  copyFileSync(SYNC_SCRIPT, join(gameRoot, 'tools', 'sync-kit.mjs'));
  const sync = spawnSync(process.execPath, ['tools/sync-kit.mjs', '--from', kit.checkout], { cwd: gameRoot, encoding: 'utf8' });
  expect(sync.status, sync.stderr).toBe(0);
  git(game, 'add', '-A');
  git(game, 'commit', '-q', '-m', 'the game');
  const origin = temporaryFolder();
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(game, 'remote', 'add', 'origin', origin);
  git(game, 'push', '-q', 'origin', 'main');
  return game;
}

interface Pull {
  number: number;
  title: string;
  labels?: string[];
  files: string[];
  /** A renamed file's old name, by its new one: what GitHub reports as `previous_filename`. */
  renamed?: Record<string, string>;
}

interface Scenario {
  pulls?: Record<string, Pull>;
  open?: { number: number; url: string; headRefName: string; commits?: unknown[] }[];
  /** `gh pr create` fails, as it does when the repo does not let workflows open pull requests. */
  createFails?: boolean;
}

/** A fake `gh` on the PATH: answers from the scenario, logs every call. */
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
const pulls = scenario.pulls || {};
if (args[0] === 'api') {
  const path = args.find((arg) => arg.startsWith('repos/'));
  const commit = /commits\\/([0-9a-f]{40})\\/pulls$/.exec(path);
  const files = /pulls\\/(\\d+)\\/files$/.exec(path);
  if (commit) {
    const pull = pulls[commit[1]];
    process.stdout.write(JSON.stringify(pull ? [{ number: pull.number, title: pull.title, labels: (pull.labels || []).map((name) => ({ name })), merge_commit_sha: commit[1], merged_at: '2026-10-14T00:00:00Z' }] : []));
  } else if (files) {
    const pull = Object.values(pulls).find((candidate) => String(candidate.number) === files[1]);
    const jq = args[args.indexOf('--jq') + 1] || '';
    const renamed = (pull && pull.renamed) || {};
    const names = (pull ? pull.files : []).flatMap((file) => (jq.includes('previous_filename') && renamed[file] ? [file, renamed[file]] : [file]));
    process.stdout.write(names.join('\\n') + '\\n');
  }
} else if (args[0] === 'pr' && args[1] === 'list') {
  // As GitHub does, refuse a list that asks for every pull request's commits.
  if ((args[args.indexOf('--json') + 1] || '').split(',').includes('commits')) {
    process.stderr.write('GraphQL: By the time this query traverses to the authors connection, it is requesting up to 1,000,000 possible nodes\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify((scenario.open || []).map(({ commits, ...pull }) => pull)));
} else if (args[0] === 'pr' && args[1] === 'view') {
  const pull = (scenario.open || []).find((candidate) => candidate.url === args[2]);
  process.stdout.write(JSON.stringify({ commits: (pull && pull.commits) || [{}] }));
} else if (args[0] === 'pr' && args[1] === 'create' && scenario.createFails) {
  process.stderr.write('pull request create failed: GitHub Actions is not permitted to create or approve pull requests\\n');
  process.exit(1);
} else if (args[0] === 'pr' && args[1] === 'create') {
  process.stderr.write('Creating pull request\\n');
  process.stdout.write(${JSON.stringify(NEW_PULL)} + '\\n');
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

/** Runs the bot as the workflow does. Holds that nothing looks like a stack trace, and that its own exit 2 prints one line on stderr. */
function runBot(env: Record<string, string>, ...commandLine: string[]): { status: number | null; output: string } {
  const gitIdentity = {
    GIT_AUTHOR_NAME: 'Kit Bump Test',
    GIT_AUTHOR_EMAIL: 'kit-bump-test@example.invalid',
    GIT_COMMITTER_NAME: 'Kit Bump Test',
    GIT_COMMITTER_EMAIL: 'kit-bump-test@example.invalid',
  };
  const result = spawnSync(process.execPath, [BOT_SCRIPT, ...commandLine], { encoding: 'utf8', env: { ...process.env, ...gitIdentity, ...env } });
  const output = result.stdout + result.stderr;
  expect(output).not.toMatch(/^\s+at .+:\d+/m);
  expect(output).not.toMatch(/node:internal|file:\/\//);
  if (result.status === 2) {
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
  }
  return { status: result.status, output };
}

function runIn(game: string, kit: Kit, env: Record<string, string>, extra: string[] = [], root = '.') {
  return runBot(env, 'run', '--game', game, '--root', root, '--kit', kit.checkout, '--kit-repo', KIT_REPO, '--repo', GAME_REPO, '--base', 'main', '--merge', 'squash', ...(extra.includes('--check') ? [] : ['--check', 'true']), ...extra);
}

const named = (calls: string[][], first: string, second: string) => calls.filter((call) => call[0] === first && call[1] === second);
const bodyOf = (call: string[]) => call[call.indexOf('--body') + 1];

describe('decide: one kit change, held for the owner or merged when green', () => {
  const pr = (title: string, files: string[], labels: string[] = []) => ({ title, files, labels });

  it('holds a commit that came from no pull request, and says so', () => {
    expect(decide({ pr: null })).toEqual({ action: 'hold', reason: expect.stringContaining('without a pull request') });
  });

  it('holds a pull request whose title starts BREAKING:', () => {
    expect(decide({ pr: pr('BREAKING: rename press', ['kit/actions.ts']) })).toEqual({ action: 'hold', reason: expect.stringContaining('"BREAKING:"') });
  });

  it.each(['kit/screens.ts', 'kit/page.ts'])('holds a change to %s without the additive label, and merges it when green with the label', (file) => {
    expect(decide({ pr: pr('Screens: a target', [file]) })).toEqual({ action: 'hold', reason: expect.stringContaining(file) });
    expect(decide({ pr: pr('Screens: a target', [file], ['additive']) })).toEqual({ action: 'merge-when-green' });
  });

  it('merges when green a change to kit/screens.test.ts alone, and any other change', () => {
    expect(decide({ pr: pr('Screens: one more test', ['kit/screens.test.ts']) })).toEqual({ action: 'merge-when-green' });
    expect(decide({ pr: pr('Clock: a pause', ['kit/clock.ts', 'kit/clock.test.ts']) })).toEqual({ action: 'merge-when-green' });
  });
});

describe('combine: every change since the pin, folded into one decision', () => {
  it('merges when green only if every change does, and holds with every distinct reason otherwise', () => {
    const merge = { decision: { action: 'merge-when-green' } };
    const breaking = { decision: { action: 'hold', reason: 'Breaking.' } };
    const direct = { decision: { action: 'hold', reason: 'Direct push.' } };
    expect(combine([merge, merge]).action).toBe('merge-when-green');
    expect(combine([merge, breaking, direct, breaking])).toEqual({ action: 'hold', reason: 'Breaking. Direct push.' });
  });
});

describe('setPinCommit', () => {
  it('sets "commit" and leaves every other key, its value and the key order as they were', () => {
    const root = temporaryFolder();
    const text = `${JSON.stringify({ repository: 'x', sha256: { a: 'b' }, commit: 'a'.repeat(40), copies: [], note: 'kept' }, null, 2)}\n`;
    writeFiles(root, { 'kit/KIT_SOURCE.json': text });
    setPinCommit(root, 'c'.repeat(40));
    expect(readFileSync(join(root, 'kit', 'KIT_SOURCE.json'), 'utf8')).toBe(text.replace('a'.repeat(40), 'c'.repeat(40)));
  });
});

describe('kit-bump run: one run in a game', () => {
  it('moves the pin on kit/<short>, runs the check, pushes, opens the pull request and merges it with the game\'s method', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } } });

    const result = runIn(game, kit, gh.env);

    expect(result.status, result.output).toBe(0);
    const branch = `kit/${kit.head.slice(0, 12)}`;
    // The branch reached the game's origin, holding only the pin and the synced files.
    expect(git(game, 'ls-remote', '--heads', 'origin', branch)).toContain(branch);
    expect(git(game, 'show', '--name-only', '--format=', branch).split('\n').sort()).toEqual(['kit/KIT_SOURCE.json', 'kit/clock.ts', 'testing/fake-time.ts']);
    expect(JSON.parse(git(game, 'show', `${branch}:kit/KIT_SOURCE.json`)).commit).toBe(kit.head);
    const calls = gh.calls();
    const create = named(calls, 'pr', 'create')[0];
    expect(create.slice(2, 10)).toEqual(['--repo', GAME_REPO, '--base', 'main', '--head', branch, '--title', `Move the kit pin to game-kit ${kit.head.slice(0, 12)}`]);
    expect(bodyOf(create)).toContain(`${KIT_REPO}#12 Clock: a pause`);
    expect(bodyOf(create)).toContain('passed');
    expect(bodyOf(create)).toContain('merge when green');
    expect(named(calls, 'pr', 'merge')).toEqual([['pr', 'merge', NEW_PULL, '--repo', GAME_REPO, '--squash', '--delete-branch']]);
  });

  it('works for a game whose kit lives under a folder', () => {
    const kit = buildKit();
    const game = buildGame(kit, 'web');
    const gh = fakeGh({ pulls: { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } } });
    expect(runIn(game, kit, gh.env, [], 'web').status).toBe(0);
    expect(git(game, 'show', '--name-only', '--format=', `kit/${kit.head.slice(0, 12)}`)).toContain('web/kit/KIT_SOURCE.json');
  });

  it('holds a BREAKING: change: opens the pull request, comments why, does not merge, exits 0', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: { [kit.head]: { number: 13, title: 'BREAKING: rename press', files: ['kit/actions.ts'] } } });

    expect(runIn(game, kit, gh.env).status).toBe(0);

    const calls = gh.calls();
    expect(named(calls, 'pr', 'create')).toHaveLength(1);
    expect(named(calls, 'pr', 'merge')).toHaveLength(0);
    expect(bodyOf(named(calls, 'pr', 'comment')[0])).toContain('Held for the owner');
  });

  it('holds a pull request that renames kit/screens.ts, which GitHub reports under its new name', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: { [kit.head]: { number: 14, title: 'Screens: a new name', files: ['kit/navigation.ts'], renamed: { 'kit/navigation.ts': 'kit/screens.ts' } } } });
    expect(runIn(game, kit, gh.env).status).toBe(0);
    expect(named(gh.calls(), 'pr', 'merge')).toHaveLength(0);
    expect(bodyOf(named(gh.calls(), 'pr', 'comment')[0])).toContain('kit/screens.ts');
  });

  it('holds a change that reached main without a pull request', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({});
    expect(runIn(game, kit, gh.env).status).toBe(0);
    expect(named(gh.calls(), 'pr', 'merge')).toHaveLength(0);
    expect(bodyOf(named(gh.calls(), 'pr', 'create')[0])).toContain('pushed to main without a pull request');
  });

  it('runs the check without GH_TOKEN or GITHUB_TOKEN', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } } });
    const env = { ...gh.env, GH_TOKEN: 'a-token', GITHUB_TOKEN: 'a-token' };
    const result = runIn(game, kit, env, ['--check', 'test -z "$GH_TOKEN" && test -z "$GITHUB_TOKEN"']);
    expect(result.status, result.output).toBe(0);
    expect(named(gh.calls(), 'pr', 'merge')).toHaveLength(1);
  });

  it('does not merge when the check fails: comments the output and exits 1', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } } });

    const result = runIn(game, kit, gh.env, ['--check', 'echo the clock test failed; exit 3']);

    expect(result.status).toBe(1);
    const calls = gh.calls();
    expect(named(calls, 'pr', 'merge')).toHaveLength(0);
    expect(bodyOf(named(calls, 'pr', 'create')[0])).toContain('failed');
    expect(bodyOf(named(calls, 'pr', 'comment')[0])).toContain('the clock test failed');
  });

  it('closes an older pin move holding only the bot\'s commit, comments on one holding more, and leaves a person\'s kit/ branch alone', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({
      pulls: { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } },
      open: [
        { number: 30, url: 'https://github.com/owner/game/pull/30', headRefName: 'kit/aaaaaaaaaaaa', commits: [{}] },
        { number: 31, url: 'https://github.com/owner/game/pull/31', headRefName: 'kit/bbbbbbbbbbbb', commits: [{}, {}] },
        { number: 32, url: 'https://github.com/owner/game/pull/32', headRefName: 'feature/menu', commits: [{}] },
        { number: 33, url: 'https://github.com/owner/game/pull/33', headRefName: 'kit/fix-input', commits: [{}] },
      ],
    });

    expect(runIn(game, kit, gh.env).status).toBe(0);

    const calls = gh.calls();
    expect(named(calls, 'pr', 'close').map((call) => call[2])).toEqual(['https://github.com/owner/game/pull/30']);
    const comments = named(calls, 'pr', 'comment').map((call) => call[2]);
    expect(comments).toEqual(['https://github.com/owner/game/pull/31']);
  });

  it('does nothing when the pin already names game-kit main', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    setPinCommit(game, kit.head);
    const gh = fakeGh({});
    const result = runIn(game, kit, gh.env);
    expect(result).toEqual({ status: 0, output: expect.stringContaining('already names') });
    expect(gh.calls()).toEqual([]);
  });

  it('does nothing when a pin move to that commit is already open', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ open: [{ number: 40, url: NEW_PULL, headRefName: `kit/${kit.head.slice(0, 12)}` }] });
    const result = runIn(game, kit, gh.env);
    expect(result).toEqual({ status: 0, output: expect.stringContaining(NEW_PULL) });
    expect(gh.calls().map((call) => call.slice(0, 2).join(' '))).toEqual(['pr list']);
    expect(git(game, 'ls-remote', '--heads', 'origin', 'kit/*')).toBe('');
  });

  it('replaces its own kit/<short> branch left on origin with no open pull request, once the repo lets workflows open them', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const branch = `kit/${kit.head.slice(0, 12)}`;
    const pulls = { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } };

    // The setting is off: the branch is pushed, opening the pull request fails.
    expect(runIn(game, kit, fakeGh({ pulls, createFails: true }).env).status).toBe(2);
    const leftover = git(game, 'ls-remote', '--heads', 'origin', branch).split('\t')[0];
    expect(leftover).toMatch(/^[0-9a-f]{40}$/);

    // The setting is on. The next run starts from a fresh checkout, as the workflow does, and commits
    // the pin move afresh, so its commit differs from the leftover one.
    const fresh = temporaryFolder();
    execFileSync('git', ['clone', '-q', '--branch', 'main', git(game, 'remote', 'get-url', 'origin'), fresh]);
    const gh = fakeGh({ pulls });
    const result = runIn(fresh, kit, { ...gh.env, GIT_COMMITTER_DATE: '2026-10-14T12:00:00Z' });

    expect(result.status, result.output).toBe(0);
    const pushed = git(fresh, 'ls-remote', '--heads', 'origin', branch).split('\t')[0];
    expect(pushed).toBe(git(fresh, 'rev-parse', branch));
    expect(pushed).not.toBe(leftover);
    expect(named(gh.calls(), 'pr', 'create')).toHaveLength(1);
    expect(named(gh.calls(), 'pr', 'merge')).toHaveLength(1);
  });

  it('does nothing for a game with no pin yet, with a line on the summary', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    rmSync(join(game, 'kit', 'KIT_SOURCE.json'));
    const summary = join(temporaryFolder(), 'summary.md');
    const gh = fakeGh({});
    expect(runIn(game, kit, gh.env, ['--summary', summary]).status).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('no kit pin yet');
    expect(gh.calls()).toEqual([]);
  });

  it('exits 1 and pushes nothing when the game\'s sync fails', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    // A copies entry the kit does not hold makes the sync tool refuse.
    const pin = JSON.parse(readFileSync(join(game, 'kit', 'KIT_SOURCE.json'), 'utf8'));
    pin.copies.push({ from: 'absent', to: 'absent' });
    writeFileSync(join(game, 'kit', 'KIT_SOURCE.json'), `${JSON.stringify(pin, null, 2)}\n`);
    git(game, 'commit', '-q', '-am', 'a pin the kit cannot satisfy');
    const gh = fakeGh({ pulls: { [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } } });

    expect(runIn(game, kit, gh.env).status).toBe(1);
    expect(named(gh.calls(), 'pr', 'create')).toHaveLength(0);
    expect(git(game, 'ls-remote', '--heads', 'origin', 'kit/*')).toBe('');
  });

  it('exits 2 with one line on a merge method a repo would not use, or a missing option', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({});
    const bad = runBot(gh.env, 'run', '--game', game, '--root', '.', '--kit', kit.checkout, '--kit-repo', KIT_REPO, '--repo', GAME_REPO, '--base', 'main', '--merge', 'fast-forward');
    expect(bad).toEqual({ status: 2, output: expect.stringContaining('merge method') });
    expect(runBot(gh.env, 'run', '--game', game).status).toBe(2);
    expect(runBot(gh.env, 'bump').status).toBe(2);
  });
});

/** The workflow's two jobs: `check` in the game checkout, then `publish` in a fresh clone of its origin, as on a new runner. */
function checkThenPublish(game: string, kit: Kit, env: Record<string, string>, check = 'true', head?: string) {
  const result = join(temporaryFolder(), 'result.json');
  const checked = runBot(env, 'check', '--game', game, '--root', '.', '--kit', kit.checkout, '--repo', GAME_REPO, '--result', result, '--check', check);
  if (head !== undefined) {
    writeFileSync(result, JSON.stringify({ ...JSON.parse(readFileSync(result, 'utf8')), head }));
  }
  const fresh = temporaryFolder();
  execFileSync('git', ['clone', '-q', '--branch', 'main', git(game, 'remote', 'get-url', 'origin'), fresh]);
  const published = runBot(env, 'publish', '--game', fresh, '--root', '.', '--kit', kit.checkout, '--kit-repo', KIT_REPO, '--repo', GAME_REPO, '--base', 'main', '--merge', 'squash', '--result', result);
  return { checked, published, fresh, result: JSON.parse(readFileSync(result, 'utf8')) as { head?: string; passed?: boolean } };
}

describe('kit-bump check, then publish: the check never runs where a token can write', () => {
  const pulls = (kit: Kit) => ({ [kit.head]: { number: 12, title: 'Clock: a pause', files: ['kit/clock.ts'] } });

  it('check runs the check and records the commit; publish pushes its own pin move, opens the pull request and merges it', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: pulls(kit) });
    const { checked, published, fresh, result } = checkThenPublish(game, kit, { ...gh.env, GH_TOKEN: 'a-token' }, 'test -z "$GH_TOKEN" && test -z "$GITHUB_TOKEN"');

    expect(checked.status, checked.output).toBe(0);
    expect(result).toMatchObject({ head: kit.head, passed: true });
    expect(published.status, published.output).toBe(0);
    const branch = `kit/${kit.head.slice(0, 12)}`;
    expect(git(fresh, 'show', '--name-only', '--format=', `origin/${branch}`).split('\n').sort()).toEqual(['kit/KIT_SOURCE.json', 'kit/clock.ts', 'testing/fake-time.ts']);
    expect(named(gh.calls(), 'pr', 'merge')).toEqual([['pr', 'merge', NEW_PULL, '--repo', GAME_REPO, '--squash', '--delete-branch']]);
  });

  it('check opens nothing and pushes nothing: only publish talks to GitHub with more than a list', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: pulls(kit) });
    const result = join(temporaryFolder(), 'result.json');
    expect(runBot(gh.env, 'check', '--game', game, '--root', '.', '--kit', kit.checkout, '--repo', GAME_REPO, '--result', result, '--check', 'true').status).toBe(0);
    expect(gh.calls().map((call) => call.slice(0, 2).join(' '))).toEqual(['pr list']);
    expect(git(game, 'ls-remote', '--heads', 'origin', 'kit/*')).toBe('');
  });

  it('a commit the check changed is never what is pushed', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: pulls(kit) });
    const amend = `git -c user.name=x -c user.email=x@example.invalid commit -q --amend -m planted && echo planted > ${'planted.txt'}`;
    const { published, fresh } = checkThenPublish(game, kit, gh.env, amend);

    expect(published.status, published.output).toBe(0);
    const pushed = git(fresh, 'log', '-1', '--format=%s', `origin/kit/${kit.head.slice(0, 12)}`);
    expect(pushed).toBe(`Move the kit pin to game-kit ${kit.head.slice(0, 12)}`);
  });

  it('a failed check: publish opens the pull request, comments the output, does not merge, exits 1', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: pulls(kit) });
    const { checked, published, result } = checkThenPublish(game, kit, gh.env, 'echo the clock test failed; exit 3');

    expect(checked.status).toBe(0);
    expect(result.passed).toBe(false);
    expect(published.status).toBe(1);
    expect(named(gh.calls(), 'pr', 'merge')).toHaveLength(0);
    expect(bodyOf(named(gh.calls(), 'pr', 'comment')[0])).toContain('the clock test failed');
  });

  it('publish believes only a commit on game-kit main: another is refused with one line and nothing pushed', () => {
    const kit = buildKit();
    const side = commitAll(kit.checkout, 'not on main', { 'kit/clock.ts': 'export const clock = 9;\n' });
    const game = buildGame(kit);
    const gh = fakeGh({ pulls: pulls(kit) });
    const { published } = checkThenPublish(game, kit, gh.env, 'true', side);

    expect(published).toEqual({ status: 2, output: expect.stringContaining('is not on game-kit main') });
    expect(git(game, 'ls-remote', '--heads', 'origin', 'kit/*')).toBe('');
    expect(named(gh.calls(), 'pr', 'create')).toHaveLength(0);
  });

  it('with nothing to do, check records nothing and publish does nothing', () => {
    const kit = buildKit();
    const game = buildGame(kit);
    setPinCommit(game, kit.head);
    git(game, 'commit', '-q', '-am', 'already on main');
    git(game, 'push', '-q', 'origin', 'main');
    const gh = fakeGh({});
    const { checked, published, result } = checkThenPublish(game, kit, gh.env);

    expect(checked.status).toBe(0);
    expect(result).toEqual({});
    expect(published).toEqual({ status: 0, output: expect.stringContaining('nothing to publish') });
    expect(gh.calls()).toEqual([]);
  });
});

describe('originAuthEnv: the token reaches git for the push, and github.com, alone', () => {
  it('gives git the token through a credential helper, never in a config value or argument', () => {
    const env = originAuthEnv({ PATH: process.env.PATH, GH_TOKEN: 'token-for-the-test' });
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith('GIT_CONFIG_')) {
        expect(value).not.toContain('token-for-the-test');
      }
    }
    const answer = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' });
    expect(answer).toContain('username=x-access-token');
    expect(answer).toContain('password=token-for-the-test');
  });

  it('gives it to https://github.com alone: asked for another host, git fails without it', () => {
    const env = originAuthEnv({ PATH: process.env.PATH, GH_TOKEN: 'token-for-the-test' });
    const asked = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=evil.example\n\n', env, encoding: 'utf8' });
    expect(asked.status).not.toBe(0);
    expect(asked.stdout).not.toContain('token-for-the-test');
  });

  it('falls back to GITHUB_TOKEN, and leaves the environment alone with no token', () => {
    expect(originAuthEnv({ GITHUB_TOKEN: 'other' }).KIT_BUMP_TOKEN).toBe('other');
    const bare = { PATH: '/bin' };
    expect(originAuthEnv(bare)).toBe(bare);
  });
});

describe('templates/kit-bump.yml: the workflow a game copies', () => {
  const template = readFileSync(TEMPLATE_FILE, 'utf8');

  it('runs every hour and by hand, one run at a time, never cancelling one in progress', () => {
    expect(template).toMatch(/schedule:\n\s+- cron: '[^']+'/);
    expect(template).toContain('workflow_dispatch');
    expect(template).toMatch(/concurrency:\n\s+group: kit-bump\n\s+cancel-in-progress: false/);
  });

  it('uses only the repo\'s own token and reads game-kit over public https', () => {
    expect(template).not.toContain('secrets.');
    expect(template).toContain('GH_TOKEN: ${{ github.token }}');
    expect(template).toContain('git clone --quiet https://github.com/eladrianovalle/game-kit.git');
  });

  it('runs the check in a job that can only read, and writes only in a later job that runs no check', () => {
    expect(template).toMatch(/^permissions: \{\}$/m);
    const [, checkJob, publishJob] = template.split(/^ {2}(?:check|publish):$/m);
    expect(checkJob).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read/);
    expect(checkJob).not.toContain('write');
    expect(checkJob).toContain('tools/kit-bump.mjs" check');
    expect(publishJob).toContain('needs: check');
    expect(publishJob).toMatch(/permissions:\n\s+contents: write\n\s+pull-requests: write/);
    expect(publishJob).toContain('tools/kit-bump.mjs" publish');
    expect(publishJob).not.toMatch(/npm|--check|setup-node/);
  });

  it('keeps no token in either job\'s checkout', () => {
    expect(template.match(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: .*\n\s+persist-credentials: false/g)).toHaveLength(2);
  });

  it('publish uses game-kit at the commit check used, and only one on main', () => {
    expect(template).toContain('merge-base --is-ancestor "$KIT_COMMIT" origin/main');
    expect(template).toContain('checkout --quiet --detach "$KIT_COMMIT"');
  });

  it('runs kit-bump.mjs from the clone with the game\'s three values', () => {
    for (const name of ['KIT_ROOT', 'KIT_BRANCH', 'KIT_MERGE']) {
      expect(template).toMatch(new RegExp(`^  ${name}: \\S+`, 'm'));
    }
    expect(template).not.toContain('tools/kit-bump.mjs" run');
    expect(template).toContain('--root "$KIT_ROOT"');
    expect(template).toContain('--base "$KIT_BRANCH" --merge "$KIT_MERGE"');
  });
});
