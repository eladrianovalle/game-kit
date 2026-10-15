// The bot that keeps a game on the latest kit. It runs in the game's own
// workflow (templates/kit-bump.yml, copied into the game once), on a schedule,
// with that repo's own token: game-kit is public, so nothing else is needed.
// The workflow clones game-kit's main and runs this file from the clone, so a
// change to the bot reaches every game without touching the games.
//
// The workflow runs it twice, in two jobs, so the game's check never runs where
// the repo's token can write. (The check job's runner still holds the runtime
// token that writes artifacts and the Actions cache. publish takes one file from
// the artifact and restores no cache; a game's other workflows that restore a
// cache saved on its base branch are outside this bot.)
//
//   node kit-bump.mjs check   --game <checkout> --root <root> --kit <game-kit clone>
//                             --repo <owner/name> --result <file> [--check <command>] [--summary <file>]
//   node kit-bump.mjs publish --game <checkout> --root <root> --kit <game-kit clone>
//                             --kit-commit <hash> --kit-repo <owner/name> --repo <owner/name>
//                             --base <branch> --merge <merge|squash|rebase> --result <file>
//                             [--summary <file>]
//
// check, in a job whose token can only read:
//   1. If the game has no pin, or its pin already names game-kit main, or a pin move
//      to that commit is already open, stop: one line, exit 0.
//   2. On a branch kit/<12-character short hash>: move the pin, run the game's own
//      sync tool, commit only the pin and the files the sync wrote.
//   3. Run the game's check (`npm ci && npm run check` in <root> unless --check). It
//      runs here because a pull request opened with the repo's own token does not
//      start the repo's other workflows. Write the commit and whether it passed.
//
// publish, in a later job on a fresh runner, the only one that can write:
//   4. Believe the result's commit only if it is --kit-commit, which the workflow
//      recorded before the check ran, is on game-kit main, and descends from the
//      pin. Repeat step 1.
//   5. Decide from every kit pull request merged since the pin: hold for the owner if
//      any was pushed without a pull request, titled `BREAKING:`, or changed
//      kit/screens.ts or kit/page.ts without the `additive` label.
//   6. Make the same pin move again with the game's own sync tool. It runs no
//      install script and no test, so nothing untrusted is alive while it holds
//      the token, and the commit the check could have changed is never pushed.
//   7. Push it, the token handed to git for github.com alone, replacing a leftover
//      kit/<short hash> branch that no open pull request holds, and open the pull
//      request. Close older open kit/<short hash> pull requests that hold only the
//      bot's commit; comment on any that hold more.
//   8. Merge it with the game's method if the check passed and nothing is held.
//      Otherwise comment why and leave it open. A failed check or sync exits 1, so
//      the run shows red.
//
// `run` does both in one process, for workflows copied before the two jobs. Its
// check runs beside the token; it goes once every game has re-copied the template.
//
// `gh` reads its token from GH_TOKEN. Exit codes: 0 done, or nothing to do; 1 the
// sync or the check failed; 2 this script cannot work with what it was given (one
// line on stderr, no stack trace).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Something this script cannot work with. Reported as one line, exit 2. */
export class CannotTell extends Error {}

/** The two kit files whose behaviour shows only in a real browser. Exact paths: their tests do not count. */
export const BROWSER_ONLY_FILES = ['kit/screens.ts', 'kit/page.ts'];
export const ADDITIVE_LABEL = 'additive';
export const BREAKING_PREFIX = 'BREAKING:';
const MERGE_METHODS = ['merge', 'squash', 'rebase'];
const DEFAULT_CHECK = 'npm ci && npm run check';
/** A branch this bot names: kit/ and a 12-character short hash. A person's kit/fix-input is not one. */
const PIN_MOVE_BRANCH = /^kit\/[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// The decision.

/**
 * Whether one kit change may reach the game by itself or waits for the owner. `pr` is null when the
 * commit on main came from no pull request, else `{ title, labels: string[], files: string[] }`. Pure.
 */
export function decide({ pr }) {
  if (pr === null || pr === undefined) {
    return { action: 'hold', reason: 'A commit reached game-kit main without a pull request, so nobody has said the change is additive.' };
  }
  if (pr.title.startsWith(BREAKING_PREFIX)) {
    return { action: 'hold', reason: `A kit pull request's title starts "${BREAKING_PREFIX}", so the game may need edits of its own before it can move.` };
  }
  const browserOnly = BROWSER_ONLY_FILES.filter((file) => pr.files.includes(file));
  if (browserOnly.length > 0 && !pr.labels.includes(ADDITIVE_LABEL)) {
    return {
      action: 'hold',
      reason: `A kit pull request changes ${browserOnly.join(' and ')} without the "${ADDITIVE_LABEL}" label, and what those change shows only in a real browser, so a person looks first.`,
    };
  }
  return { action: 'merge-when-green' };
}

/** Folds the decisions for every change since the pin into one: held if any is held, with every reason. */
export function combine(changes) {
  const holds = changes.filter((change) => change.decision.action === 'hold');
  if (holds.length === 0) {
    return { action: 'merge-when-green', reason: `Every kit change since the pin is additive: none is titled "${BREAKING_PREFIX}", and none changes ${BROWSER_ONLY_FILES.join(' or ')} without the "${ADDITIVE_LABEL}" label.` };
  }
  return { action: 'hold', reason: [...new Set(holds.map((change) => change.decision.reason))].join(' ') };
}

// ---------------------------------------------------------------------------
// git and gh.

/**
 * The environment for a git command that talks to the game's origin. The workflow checks the game out
 * without keeping its token in .git/config; the token is handed to git here, for one command and for
 * https://github.com alone, through a credential helper that reads it from the environment, so it
 * never appears in a command line or a file. With no token (the tests' local origin) the environment
 * is unchanged.
 */
export function originAuthEnv(env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    return env;
  }
  return {
    ...env,
    KIT_BUMP_TOKEN: token,
    // Asked for any other host, git finds no helper and fails rather than prompting.
    GIT_TERMINAL_PROMPT: '0',
    // Replaces any GIT_CONFIG_* pairs already in the environment; the template sets none.
    GIT_CONFIG_COUNT: '2',
    // An empty helper first drops any helper the runner set up, so only this one answers.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$KIT_BUMP_TOKEN"; }; f',
  };
}

function runGit(checkout, ...commandLine) {
  return runGitWith(process.env, checkout, ...commandLine);
}

function runGitWith(env, checkout, ...commandLine) {
  const result = spawnSync('git', ['-C', checkout, ...commandLine], { encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new CannotTell(`git ${commandLine[0]} failed in ${checkout}: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
  }
  return result.stdout;
}

function runGh(...commandLine) {
  const result = spawnSync('gh', commandLine, { encoding: 'utf8' });
  if (result.error) {
    throw new CannotTell(`cannot run gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CannotTell(`gh ${commandLine.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
  }
  return result.stdout;
}

function ghJson(...commandLine) {
  const text = runGh(...commandLine);
  try {
    return JSON.parse(text);
  } catch {
    throw new CannotTell(`gh ${commandLine.slice(0, 2).join(' ')} did not return JSON`);
  }
}

/**
 * The kit changes between the pinned commit and `head`: one per commit on main's first-parent line,
 * newest first, each with the pull request that merged it (or null) and its decision.
 */
export function changesSince({ kit, kitRepo, pinned, head }) {
  const commits = runGit(kit, 'rev-list', '--first-parent', `${pinned}..${head}`).split('\n').filter(Boolean);
  return commits.map((sha) => {
    const pulls = ghJson('api', `repos/${kitRepo}/commits/${sha}/pulls`);
    const pull = Array.isArray(pulls) ? pulls.find((candidate) => candidate?.merge_commit_sha === sha && candidate.merged_at) : undefined;
    if (pull === undefined) {
      return { sha, pullRequest: null, decision: decide({ pr: null }) };
    }
    // A renamed file counts under its old name too, so moving kit/screens.ts away still holds.
    const files = runGh('api', '--paginate', `repos/${kitRepo}/pulls/${pull.number}/files`, '--jq', '.[] | .filename, .previous_filename // empty').split('\n').filter(Boolean);
    const pr = { title: String(pull.title ?? ''), labels: (pull.labels ?? []).map((label) => label.name), files };
    return { sha, pullRequest: { number: pull.number, title: pr.title }, decision: decide({ pr }) };
  });
}

// ---------------------------------------------------------------------------
// The pin.

/** Where a game keeps its pin, given the folder that holds its tools/ and kit/. */
export function pinPath(gameRoot) {
  return join(gameRoot, 'kit', 'KIT_SOURCE.json');
}

/** Sets the pin's "commit" to a full hash. Every other key, its value and the key order stay as they were. */
export function setPinCommit(gameRoot, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new CannotTell(`the commit must be a full commit hash, 40 hex characters, not "${commit}"`);
  }
  const path = pinPath(gameRoot);
  let pin;
  try {
    pin = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CannotTell(`cannot read ${path}: ${error.message.split('\n')[0]}`);
  }
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) {
    throw new CannotTell(`${path} must hold a JSON object`);
  }
  // Assigning to an existing key keeps its place in the order.
  pin.commit = commit;
  writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
}

/** The paths under these pathspecs that differ from HEAD or are untracked, relative to the checkout. */
function changedPaths(checkout, pathspecs) {
  const status = runGit(checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs);
  // Each entry is "XY path". Nothing is staged here, so there are no renames and no second path.
  return status.split('\0').filter((entry) => entry.length > 0).map((entry) => entry.slice(3));
}

/**
 * On a new branch kit/<short hash>: moves the pin, runs the game's own sync tool, and commits only the
 * pin and the files the sync wrote. Returns false, committing nothing, if the sync fails.
 */
export function movePin({ game, root, commit, kit }) {
  const gameRoot = resolve(game, root);
  const syncTool = join(gameRoot, 'tools', 'sync-kit.mjs');
  if (!existsSync(syncTool)) {
    throw new CannotTell(`${syncTool} does not exist: this game has no sync tool to copy the kit with`);
  }
  const rootInCheckout = posix.normalize(root.split('\\').join('/'));
  const pathspecs = ['kit', 'testing', 'tools/sync-kit.mjs'].map((path) => posix.join(rootInCheckout, path));
  const toolBefore = readFileSync(syncTool);

  runGit(game, 'checkout', '-q', '-b', `kit/${commit.slice(0, 12)}`);
  setPinCommit(gameRoot, commit);
  const sync = () => spawnSync(process.execPath, [join('tools', 'sync-kit.mjs'), '--from', resolve(kit)], { cwd: gameRoot, stdio: 'inherit' }).status;
  let status = sync();
  // A new sync tool came in with the kit: run once more, so the new tool has done the copy.
  if (status === 0 && !readFileSync(syncTool).equals(toolBefore)) {
    status = sync();
  }
  if (status !== 0) {
    return false;
  }
  runGit(game, 'add', '--', ...changedPaths(game, pathspecs));
  runGit(
    game,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    `Move the kit pin to game-kit ${commit.slice(0, 12)}\n\nCopies game-kit ${commit} with the game's own tools/sync-kit.mjs. Only the pin and the files the sync wrote are in this commit.`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// The pull request.

/** The title and body of a pin-move pull request. */
export function pinMovePullRequest({ head, kitRepo, changes, decision, check }) {
  const lines = changes.map((change) =>
    change.pullRequest === null
      ? `- ${change.sha.slice(0, 12)}: pushed to main without a pull request`
      : `- ${kitRepo}#${change.pullRequest.number} ${change.pullRequest.title}`,
  );
  return {
    title: `Move the kit pin to game-kit ${head.slice(0, 12)}`,
    body: [
      `Moves this game's kit pin to game-kit ${head}, copied with this game's own \`tools/sync-kit.mjs\`. Opened by the kit-bump workflow.`,
      '',
      'Kit changes since the last pin:',
      ...lines,
      '',
      `- Check (\`${check.command}\`): ${check.passed ? 'passed' : 'failed'}`,
      `- Decision: ${decision.action === 'hold' ? 'hold for the owner' : 'merge when green'}`,
      `- Reason: ${decision.reason}`,
    ].join('\n'),
  };
}

/** Closes older open pin moves that hold only the bot's commit, and comments on any that hold more. */
function retireOlder({ repo, open, url }) {
  for (const older of open) {
    const { commits } = ghJson('pr', 'view', older.url, '--repo', repo, '--json', 'commits');
    if ((commits?.length ?? 1) > 1) {
      runGh('pr', 'comment', older.url, '--repo', repo, '--body', `${url} moves the pin to a newer game-kit commit. This pull request holds edits beyond the pin move, so it is left open: carry them onto ${url}, then close this one.`);
    } else {
      runGh('pr', 'close', older.url, '--repo', repo, '--comment', `Replaced by ${url}, which moves the pin to a newer game-kit commit. A pin holds every kit change before it.`);
    }
  }
}

/** The last lines of a check's output, for a comment. */
function tail(text, lines = 40) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// One run.

function report(summary, line) {
  console.log(`kit-bump: ${line}`);
  if (summary) {
    appendFileSync(summary, `- ${line}\n`);
  }
}

/**
 * What every command first asks: does this game have a pin, is it behind `head`, and is no pin move to
 * `head` already open? Returns null, after one line on the summary, when there is nothing to do.
 */
function pendingMove({ game, root, kit, repo, head, summary }) {
  const gameRoot = resolve(game, root);
  if (!existsSync(pinPath(gameRoot))) {
    report(summary, `${pinPath(gameRoot)} does not exist: this game has no kit pin yet, so there is nothing to move`);
    return null;
  }
  let pinned;
  try {
    pinned = JSON.parse(readFileSync(pinPath(gameRoot), 'utf8')).commit;
  } catch (error) {
    throw new CannotTell(`cannot read ${pinPath(gameRoot)}: ${error.message.split('\n')[0]}`);
  }
  const kitHead = head ?? runGit(kit, 'rev-parse', 'origin/main').trim();
  if (pinned === kitHead) {
    report(summary, `the pin already names game-kit main, ${kitHead}`);
    return null;
  }
  const branch = `kit/${kitHead.slice(0, 12)}`;
  // No `commits` here: asked of 200 pull requests, GitHub refuses the query as too large. retireOlder
  // asks for them, one pin move at a time.
  const open = ghJson('pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,url,headRefName').filter((pull) =>
    PIN_MOVE_BRANCH.test(pull.headRefName),
  );
  const already = open.find((pull) => pull.headRefName === branch);
  if (already !== undefined) {
    report(summary, `a pin move to ${kitHead} is already open, waiting on a person: ${already.url}`);
    return null;
  }
  return { gameRoot, pinned, head: kitHead, branch, open };
}

/** Runs the game's check with no token in its environment. */
function runCheck(gameRoot, check) {
  const { GH_TOKEN: _ghToken, GITHUB_TOKEN: _githubToken, ...checkEnv } = process.env;
  const result = spawnSync('bash', ['-c', check], { cwd: gameRoot, encoding: 'utf8', env: checkEnv });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return { command: check, passed: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Pushes the committed pin move, opens its pull request, retires older ones, and merges or says why not. */
function publishMove({ game, kitRepo, repo, base, merge, move, changes, decision, checked, summary }) {
  const { head, branch, open } = move;
  // A kit/<short> branch already on origin that no open pull request holds is this bot's own leftover:
  // a run that pushed and then failed to open its pull request, or a pin move closed unmerged. This
  // run's commit is new, so replace the branch, but only if it still holds the commit seen here.
  const authed = originAuthEnv(process.env);
  const leftover = runGitWith(authed, game, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\t')[0].trim();
  runGitWith(authed, game, 'push', '-q', ...(leftover ? [`--force-with-lease=refs/heads/${branch}:${leftover}`] : []), 'origin', `${branch}:refs/heads/${branch}`);
  const { title, body } = pinMovePullRequest({ head, kitRepo, changes, decision, check: checked });
  const url = runGh('pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', title, '--body', body).trim().split('\n').pop();
  retireOlder({ repo, open, url });

  if (!checked.passed) {
    runGh('pr', 'comment', url, '--repo', repo, '--body', `Not merged: \`${checked.command}\` failed with the new kit. It stays open for a person.\n\n\`\`\`\n${tail(checked.output)}\n\`\`\``);
    report(summary, `the check failed with game-kit ${head}; left ${url} open`);
    return 1;
  }
  if (decision.action === 'hold') {
    runGh('pr', 'comment', url, '--repo', repo, '--body', `Held for the owner, not merged by the bot. ${decision.reason} The check passed; merge it by hand once someone has looked.`);
    report(summary, `held ${url} for the owner: ${decision.reason}`);
    return 0;
  }
  runGh('pr', 'merge', url, '--repo', repo, `--${merge}`, '--delete-branch');
  report(summary, `merged ${url}: the game now runs game-kit ${head}`);
  return 0;
}

function checkMergeMethod(merge) {
  if (!MERGE_METHODS.includes(merge)) {
    throw new CannotTell(`the merge method must be one of ${MERGE_METHODS.join(', ')}, not "${merge}"`);
  }
}

/**
 * The workflow's first job, which holds no token that can write. Moves the pin in this checkout, runs
 * the game's check, and writes `{ head, passed, command, output }` to `result` for `publish`, or `{}`
 * when there is nothing to do. Exits 0 even when the check fails, so `publish` opens the pull request
 * that says so; 1 only when the sync fails.
 */
export function runCheckJob({ game, root, kit, repo, check = DEFAULT_CHECK, result, summary }) {
  const move = pendingMove({ game, root, kit, repo, summary });
  if (move === null) {
    writeFileSync(result, '{}\n');
    return 0;
  }
  if (!movePin({ game, root, commit: move.head, kit })) {
    writeFileSync(result, '{}\n');
    report(summary, `the game's sync tool failed for game-kit ${move.head}; nothing was committed or pushed`);
    return 1;
  }
  const checked = runCheck(move.gameRoot, check);
  writeFileSync(result, `${JSON.stringify({ head: move.head, passed: checked.passed, command: checked.command, output: tail(checked.output) })}\n`);
  report(summary, `the check ${checked.passed ? 'passed' : 'failed'} with game-kit ${move.head}`);
  return 0;
}

/**
 * The workflow's second job, the only one with a token that can write. It never runs the game's check
 * or installs anything: from a fresh checkout it makes the same pin move again with the game's own
 * sync tool, pushes that, and takes from `check` only whether the check passed. The commit `check`
 * tested is never pushed, so nothing the check ran can change what is merged. The check wrote the
 * result file, so it can always say it passed; that much is inherent. It cannot also choose the
 * commit: `kitCommit` is what the workflow recorded before the check ran, and the result must name it.
 */
export function runPublishJob({ game, root, kit, kitCommit, kitRepo, repo, base, merge, result, summary }) {
  checkMergeMethod(merge);
  if (typeof kitCommit !== 'string' || !/^[0-9a-f]{40}$/.test(kitCommit)) {
    throw new CannotTell(`--kit-commit must be a full commit hash, 40 hex characters, not "${kitCommit}"`);
  }
  let checked;
  try {
    // One regular file from the check job's artifact, and nothing else of it.
    if (!lstatSync(result).isFile()) {
      throw new Error('not a regular file');
    }
    checked = JSON.parse(readFileSync(result, 'utf8'));
  } catch (error) {
    throw new CannotTell(`cannot read ${result}: ${error.message.split('\n')[0]}`);
  }
  if (checked.head === undefined) {
    report(summary, 'nothing to publish');
    return 0;
  }
  // The result came from a job that ran untrusted install scripts: believe only the commit recorded
  // before they ran, and only if it is on game-kit main.
  if (checked.head !== kitCommit) {
    throw new CannotTell(`${result} names ${checked.head}, not ${kitCommit}, the commit the workflow recorded before the check ran`);
  }
  if (spawnSync('git', ['-C', kit, 'merge-base', '--is-ancestor', checked.head, 'origin/main']).status !== 0) {
    throw new CannotTell(`${checked.head} is not on game-kit main, so it is not pinned`);
  }
  const move = pendingMove({ game, root, kit, repo, head: checked.head, summary });
  if (move === null) {
    return 0;
  }
  // A pin only moves forward: never to an older commit, whose changes since the pin would be none.
  if (spawnSync('git', ['-C', kit, 'merge-base', '--is-ancestor', move.pinned, move.head]).status !== 0) {
    throw new CannotTell(`${move.head} does not come after the pin, ${move.pinned}, on game-kit main, so the pin is not moved back to it`);
  }
  const changes = changesSince({ kit, kitRepo, pinned: move.pinned, head: move.head });
  const decision = combine(changes);
  if (!movePin({ game, root, commit: move.head, kit })) {
    report(summary, `the game's sync tool failed for game-kit ${move.head}; nothing was pushed`);
    return 1;
  }
  return publishMove({
    game, kitRepo, repo, base, merge, move, changes, decision, summary,
    checked: { command: String(checked.command), passed: checked.passed === true, output: String(checked.output ?? '') },
  });
}

/**
 * The single-job run that workflows copied before the two-job template use: the check runs in the
 * same job, and the same checkout, as the push. Kept so those keep working until they re-copy the
 * template; the check there can reach the token.
 */
export function runOnce({ game, root, kit, kitRepo, repo, base, merge, check = DEFAULT_CHECK, summary }) {
  checkMergeMethod(merge);
  const move = pendingMove({ game, root, kit, repo, summary });
  if (move === null) {
    return 0;
  }
  const changes = changesSince({ kit, kitRepo, pinned: move.pinned, head: move.head });
  const decision = combine(changes);
  if (!movePin({ game, root, commit: move.head, kit })) {
    report(summary, `the game's sync tool failed for game-kit ${move.head}; nothing was committed or pushed`);
    return 1;
  }
  const checked = runCheck(move.gameRoot, check);
  return publishMove({ game, kitRepo, repo, base, merge, move, changes, decision, checked, summary });
}

// ---------------------------------------------------------------------------
// The command line.

const USAGE = [
  'check --game <dir> --root <root> --kit <game-kit clone> --repo <owner/name> --result <file> [--check <command>] [--summary <file>]',
  'publish --game <dir> --root <root> --kit <game-kit clone> --kit-commit <hash> --kit-repo <owner/name> --repo <owner/name> --base <branch> --merge <method> --result <file> [--summary <file>]',
  'run (the older single job): --game --root --kit --kit-repo --repo --base --merge [--check] [--summary]',
].join(' | ');

function option(commandLine, name, { required }) {
  const index = commandLine.indexOf(name);
  if (index === -1) {
    if (required) {
      throw new CannotTell(`${commandLine[0]} needs ${name} <value>. Usage: node kit-bump.mjs ${USAGE}`);
    }
    return undefined;
  }
  const value = commandLine[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CannotTell(`${commandLine[0]} needs ${name} <value>. Usage: node kit-bump.mjs ${USAGE}`);
  }
  return value;
}

function main(commandLine) {
  const required = (name) => option(commandLine, name, { required: true });
  const optional = (name) => option(commandLine, name, { required: false });
  switch (commandLine[0]) {
    case 'check':
      return runCheckJob({
        game: required('--game'), root: required('--root'), kit: required('--kit'), repo: required('--repo'),
        result: required('--result'), check: optional('--check'), summary: optional('--summary'),
      });
    case 'publish':
      return runPublishJob({
        game: required('--game'), root: required('--root'), kit: required('--kit'), kitCommit: required('--kit-commit'),
        kitRepo: required('--kit-repo'), repo: required('--repo'), base: required('--base'), merge: required('--merge'),
        result: required('--result'), summary: optional('--summary'),
      });
    case 'run':
      return runOnce({
        game: required('--game'), root: required('--root'), kit: required('--kit'), kitRepo: required('--kit-repo'),
        repo: required('--repo'), base: required('--base'), merge: required('--merge'),
        check: optional('--check'), summary: optional('--summary'),
      });
    default:
      throw new CannotTell(`pass a command: ${USAGE}`);
  }
}

// Run only as a command, not when a test imports the functions above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // One line and no stack trace, whatever went wrong.
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.error(`kit-bump: ${message}`);
    process.exitCode = 2;
  }
}
