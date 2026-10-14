// What game-kit's own CI needs to know about the games that copy the kit, and
// the one edit it makes to a game: moving the game's pin to a game-kit commit.
// The list of games is games.json at the repo root. Not copied into games.
//
//   node tools/games.mjs matrix
//       print games.json, checked, as one line of JSON, for a workflow matrix
//
//   node tools/games.mjs try --game <game checkout> --root <root> --commit <hash> --from <game-kit checkout>
//       set the pin's "commit" in <game checkout>/<root>/kit/KIT_SOURCE.json to <hash>,
//       then run the game's own `node tools/sync-kit.mjs --from <game-kit checkout>` in
//       <game checkout>/<root>, and exit with its exit code
//
// The games check (.github/workflows/games.yml) runs both on every pull request to main.
//
// The bot (.github/workflows/bump.yml) runs the rest on every push to main:
//
//   node tools/games.mjs merged-pull --pulls <file> --sha <hash>
//       print the number of the pull request whose merge commit is <hash>, from the
//       JSON of `gh api repos/<repo>/commits/<hash>/pulls`; print nothing if there is none
//
//   node tools/games.mjs decide --pulls <file> --sha <hash> --files <file> [--output <file>]
//       decide once, for every game, whether the pin moves merge when green or are held
//       for the owner. <files> lists the pull request's changed files, one per line.
//       Prints the decision as one line of JSON; with --output, appends `decision=<it>`
//
//   node tools/games.mjs move-pin --game <game checkout> --root <root> --commit <hash> --from <game-kit checkout>
//                                 [--output <file>] [--summary <file>]
//       in a game checkout at its branch: if the pin already names <hash>, do nothing.
//       Otherwise branch kit/<12-character short hash>, move the pin, run the game's own
//       sync tool, and commit only the pin and the files the sync wrote. A game with no
//       pin, no sync tool, or a failing sync is skipped: one line, and exit 0.
//       --output gets `moved=`, `branch=` and `skipped=`; --summary gets the skip line
//
//   node tools/games.mjs open-pr --repo <owner/name> --base <branch> --head <branch> --commit <hash>
//                                --decision <json> --kit-repo <owner/name> [--output <file>]
//       open the pin-move pull request (or reuse the open one from that head), then close
//       every older open kit/* pull request in that game with a comment naming it.
//       Prints its address; --output gets `url=`
//
//   node tools/games.mjs finish --repo <owner/name> --pr <address> --decision <json> --merge <merge|squash|rebase>
//                               [--timeout-seconds <n>] [--poll-seconds <n>] [--summary <file>]
//       on hold, comment why and leave it open. On merge when green, wait (30 minutes by
//       default) for at least one check to report and all to pass, then merge with the
//       game's method and delete the branch; otherwise comment why and leave it open
//
// open-pr and finish run `gh`, which reads its token from GH_TOKEN.
//
// Exit codes: 0 done; 2 this script cannot work with what it was given (one
// line on stderr, no stack trace). `try` otherwise passes on the sync tool's code.
//
// Option, used by the tests:
//   --games <file>   read this file in place of games.json

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GAMES_FILE = join(REPO_DIRECTORY, 'games.json');
const GAME_FIELDS = ['repo', 'branch', 'root', 'merge'];

/** Something this script cannot work with. Reported as one line, exit 2. */
export class CannotTell extends Error {}

/** The games in a games file, each with a non-empty `repo`, `branch`, `root` and `merge`. */
export function readGames(gamesFile = GAMES_FILE) {
  let games;
  try {
    games = JSON.parse(readFileSync(gamesFile, 'utf8'));
  } catch (error) {
    throw new CannotTell(`cannot read ${gamesFile}: ${error.message.split('\n')[0]}`);
  }
  if (!Array.isArray(games) || games.length === 0) {
    throw new CannotTell(`${gamesFile} must be a list of games`);
  }
  games.forEach((game, index) => {
    for (const field of GAME_FIELDS) {
      if (typeof game?.[field] !== 'string' || game[field].length === 0) {
        throw new CannotTell(`${gamesFile}: game ${index + 1} has no "${field}"`);
      }
    }
  });
  return games;
}

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
  if (!existsSync(path)) {
    throw new CannotTell(`${path} does not exist: this game has no kit pin, so the kit cannot be tried in it`);
  }
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

/** Moves the game's pin to a commit and runs the game's own sync tool against the game-kit checkout. Returns its exit code. */
export function tryKitInGame({ game, root, commit, from }) {
  const gameRoot = resolve(game, root);
  setPinCommit(gameRoot, commit);
  const syncTool = join(gameRoot, 'tools', 'sync-kit.mjs');
  if (!existsSync(syncTool)) {
    throw new CannotTell(`${syncTool} does not exist: this game has no sync tool to copy the kit with`);
  }
  // The game's own copy of the tool, run where the game runs it, so the check tries what the game will do.
  const sync = spawnSync(process.execPath, [join('tools', 'sync-kit.mjs'), '--from', resolve(from)], { cwd: gameRoot, stdio: 'inherit' });
  return sync.status ?? 1;
}

// ---------------------------------------------------------------------------
// The bot: the decision.

/** The two kit files whose behaviour shows only in a real browser. Exact paths: their tests do not count. */
export const BROWSER_ONLY_FILES = ['kit/screens.ts', 'kit/page.ts'];
export const ADDITIVE_LABEL = 'additive';
export const BREAKING_PREFIX = 'BREAKING:';

/**
 * Whether the pin moves for a merged kit pull request merge themselves once each game's checks pass,
 * or wait for the owner. `pr` is null when the push merged no pull request, else
 * `{ title, labels: string[], files: string[] }`. Pure.
 */
export function decide({ pr }) {
  if (pr === null || pr === undefined) {
    return { action: 'hold', reason: 'No merged pull request was found for this push to main, so nobody has said the change is additive.' };
  }
  if (pr.title.startsWith(BREAKING_PREFIX)) {
    return { action: 'hold', reason: `The kit pull request's title starts "${BREAKING_PREFIX}", so each game may need edits of its own before it can move.` };
  }
  const browserOnly = BROWSER_ONLY_FILES.filter((file) => pr.files.includes(file));
  if (browserOnly.length > 0 && !pr.labels.includes(ADDITIVE_LABEL)) {
    return {
      action: 'hold',
      reason: `The kit pull request changes ${browserOnly.join(' and ')} without the "${ADDITIVE_LABEL}" label, and what those change shows only in a real browser, so a person looks first.`,
    };
  }
  return { action: 'merge-when-green' };
}

/** The reason a merge-when-green decision gives in a pin-move pull request. */
const MERGE_WHEN_GREEN_REASON = `The kit pull request is additive: its title does not start "${BREAKING_PREFIX}", and it changes neither ${BROWSER_ONLY_FILES.join(' nor ')}, or it carries the "${ADDITIVE_LABEL}" label.`;

/** The pull request a push to main merged: the one whose merge commit is the pushed commit. Null if none. */
export function mergedPullRequest(pulls, sha) {
  if (!Array.isArray(pulls)) {
    throw new CannotTell('the list of pull requests must be the JSON list GitHub returns for a commit');
  }
  return pulls.find((pull) => pull?.merge_commit_sha === sha && pull.merged_at) ?? null;
}

/** The decision as the workflow carries it: the action, its reason, and the kit pull request it is about. */
export function decisionFor(pulls, sha, files) {
  const pull = mergedPullRequest(pulls, sha);
  const pr = pull === null ? null : { title: String(pull.title ?? ''), labels: (pull.labels ?? []).map((label) => label.name), files };
  const decision = decide({ pr });
  return {
    action: decision.action,
    reason: decision.reason ?? MERGE_WHEN_GREEN_REASON,
    pullRequest: pull === null ? null : { number: pull.number, url: pull.html_url, title: pr.title },
  };
}

// ---------------------------------------------------------------------------
// The bot: moving one game's pin.

function runGit(checkout, ...commandLine) {
  const result = spawnSync('git', ['-C', checkout, ...commandLine], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new CannotTell(`git ${commandLine[0]} failed in ${checkout}: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
  }
  return result.stdout;
}

/** The paths under these pathspecs that differ from HEAD or are untracked, relative to the checkout. */
function changedPaths(checkout, pathspecs) {
  const status = runGit(checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs);
  // Each entry is "XY path". Nothing is staged here, so there are no renames and no second path.
  return status.split('\0').filter((entry) => entry.length > 0).map((entry) => entry.slice(3));
}

/** A game skipped by the bot: one line out, and on the summary if there is one. */
function skip(message, { output, summary }) {
  console.log(`games.mjs: skipped: ${message}`);
  if (output) {
    appendFileSync(output, `moved=false\nskipped=${message}\n`);
  }
  if (summary) {
    appendFileSync(summary, `- skipped: ${message}\n`);
  }
  return { moved: false, skipped: message };
}

/**
 * Moves a game's pin to a game-kit commit on a branch kit/<short hash>, runs the game's own sync tool,
 * and commits only the pin and the files the sync wrote. `game` is a checkout at the game's branch.
 */
export function movePin({ game, root, commit, from, output, summary }) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new CannotTell(`the commit must be a full commit hash, 40 hex characters, not "${commit}"`);
  }
  const gameRoot = resolve(game, root);
  const short = commit.slice(0, 12);
  const branch = `kit/${short}`;
  const pin = pinPath(gameRoot);
  if (!existsSync(pin)) {
    return skip(`${pin} does not exist: this game has no kit pin, so its pin cannot be moved`, { output, summary });
  }
  let pinned;
  try {
    pinned = JSON.parse(readFileSync(pin, 'utf8')).commit;
  } catch (error) {
    return skip(`cannot read ${pin}: ${error.message.split('\n')[0]}`, { output, summary });
  }
  if (pinned === commit) {
    console.log(`games.mjs: the pin already names ${commit}; nothing to do`);
    if (output) {
      appendFileSync(output, 'moved=false\nskipped=\n');
    }
    return { moved: false };
  }
  const syncTool = join(gameRoot, 'tools', 'sync-kit.mjs');
  if (!existsSync(syncTool)) {
    return skip(`${syncTool} does not exist: this game has no sync tool to copy the kit with`, { output, summary });
  }

  // Paths relative to the checkout, as git status and git add take them.
  const rootInCheckout = posix.normalize(root.split('\\').join('/'));
  const pathspecs = ['kit', 'testing', 'tools/sync-kit.mjs'].map((path) => posix.join(rootInCheckout, path));
  const toolBefore = readFileSync(syncTool);

  runGit(game, 'checkout', '-q', '-b', branch);
  setPinCommit(gameRoot, commit);
  const sync = () => spawnSync(process.execPath, [join('tools', 'sync-kit.mjs'), '--from', resolve(from)], { cwd: gameRoot, stdio: 'inherit' }).status;
  let status = sync();
  // A new sync tool came in with the kit: run once more, so the new tool has done the copy.
  if (status === 0 && !readFileSync(syncTool).equals(toolBefore)) {
    status = sync();
  }
  if (status !== 0) {
    return skip(`the game's sync tool exited ${status ?? 'on a signal'} for ${commit}; nothing was committed`, { output, summary });
  }

  const paths = changedPaths(game, pathspecs);
  runGit(game, 'add', '--', ...paths);
  runGit(
    game,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    `Move the kit pin to game-kit ${short}\n\nCopies game-kit ${commit} with the game's own tools/sync-kit.mjs. Only the pin and the files the sync wrote are in this commit.`,
  );
  console.log(`games.mjs: moved the pin to ${commit} on ${branch}, committing ${paths.length} file(s)`);
  if (output) {
    appendFileSync(output, `moved=true\nbranch=${branch}\nskipped=\n`);
  }
  return { moved: true, branch, paths };
}

// ---------------------------------------------------------------------------
// The bot: the pin-move pull request in a game, through `gh`.

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

function parseDecision(text) {
  let decision;
  try {
    decision = JSON.parse(text);
  } catch (error) {
    throw new CannotTell(`the decision is not JSON: ${error.message.split('\n')[0]}`);
  }
  if (!['hold', 'merge-when-green'].includes(decision?.action) || typeof decision.reason !== 'string') {
    throw new CannotTell('the decision must be the JSON `decide` prints, with an action and a reason');
  }
  return decision;
}

/** The title and body of a pin-move pull request. */
export function pinMovePullRequest({ commit, decision, kitRepo }) {
  const short = commit.slice(0, 12);
  const kitPull = decision.pullRequest === null ? `none: ${commit} was pushed to ${kitRepo} main directly` : `${kitRepo}#${decision.pullRequest.number} (${decision.pullRequest.title})`;
  const action = decision.action === 'hold' ? 'hold for the owner' : 'merge when green';
  return {
    title: `Move the kit pin to game-kit ${short}`,
    body: [
      `Moves this game's kit pin to game-kit ${commit}, and copies its files with this game's own \`tools/sync-kit.mjs\`. Opened by game-kit's bot.`,
      '',
      `- Kit pull request: ${kitPull}`,
      `- Decision: ${action}`,
      `- Reason: ${decision.reason}`,
    ].join('\n'),
  };
}

/** Opens the pin-move pull request, or reuses the open one from that head, and closes older open kit/* pull requests. Returns its address. */
export function openPinMove({ repo, base, head, commit, decision, kitRepo }) {
  const open = JSON.parse(runGh('pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,url,headRefName'));
  let url = open.find((pull) => pull.headRefName === head)?.url;
  if (url === undefined) {
    const { title, body } = pinMovePullRequest({ commit, decision, kitRepo });
    url = runGh('pr', 'create', '--repo', repo, '--base', base, '--head', head, '--title', title, '--body', body).trim().split('\n').pop();
  }
  for (const older of open.filter((pull) => pull.headRefName.startsWith('kit/') && pull.headRefName !== head)) {
    runGh('pr', 'close', older.url, '--repo', repo, '--comment', `Replaced by ${url}, which moves the pin to a newer game-kit commit. A pin holds every kit change before it.`);
  }
  return url;
}

/** Where a pull request's checks stand, from `gh pr view --json statusCheckRollup`: waiting, failed or passed. */
export function checksVerdict(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { state: 'waiting', reason: 'no check has reported' };
  }
  let running = 0;
  for (const check of rollup) {
    const name = check.name || check.context || 'a check';
    if (check.__typename === 'StatusContext') {
      if (check.state === 'SUCCESS') continue;
      if (check.state === 'PENDING' || check.state === 'EXPECTED') {
        running += 1;
        continue;
      }
      return { state: 'failed', reason: `the check "${name}" ended ${String(check.state).toLowerCase()}` };
    }
    if (check.status !== 'COMPLETED') {
      running += 1;
      continue;
    }
    if (check.conclusion !== 'SUCCESS') {
      return { state: 'failed', reason: `the check "${name}" ended ${String(check.conclusion).toLowerCase()}` };
    }
  }
  if (running > 0) {
    return { state: 'waiting', reason: `${running} of ${rollup.length} check(s) had not finished` };
  }
  return { state: 'passed', reason: `all ${rollup.length} check(s) passed` };
}

/**
 * Polls a pull request's checks until at least one has reported and all have passed, one fails, or time
 * runs out. A pass is taken only when two polls in a row see it, so a check that registers late is not
 * missed. `read` returns the rollup; `sleep` and `now` work in milliseconds.
 */
export function waitForChecks({ read, sleep, now, timeoutMs, pollMs }) {
  const deadline = now() + timeoutMs;
  let passes = 0;
  for (;;) {
    const verdict = checksVerdict(read());
    if (verdict.state === 'failed') {
      return verdict;
    }
    passes = verdict.state === 'passed' ? passes + 1 : 0;
    if (passes >= 2) {
      return verdict;
    }
    if (now() + pollMs > deadline) {
      return { state: 'timed-out', reason: `after ${Math.round(timeoutMs / 60000)} minute(s), ${verdict.reason}` };
    }
    sleep(pollMs);
  }
}

const MERGE_METHODS = ['merge', 'squash', 'rebase'];

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Merges a pin-move pull request once its checks pass, or comments why it stays open. Returns what happened. */
export function finishPinMove({ repo, pr, decision, merge, timeoutMs, pollMs }) {
  if (!MERGE_METHODS.includes(merge)) {
    throw new CannotTell(`the merge method must be one of ${MERGE_METHODS.join(', ')}, not "${merge}"`);
  }
  if (decision.action === 'hold') {
    runGh('pr', 'comment', pr, '--repo', repo, '--body', `Held for the owner, not merged by the bot. ${decision.reason} Merge it by hand once its checks pass.`);
    return { merged: false, reason: decision.reason };
  }
  const verdict = waitForChecks({
    read: () => JSON.parse(runGh('pr', 'view', pr, '--repo', repo, '--json', 'statusCheckRollup')).statusCheckRollup,
    sleep: sleepSync,
    now: Date.now,
    timeoutMs,
    pollMs,
  });
  if (verdict.state !== 'passed') {
    const reason = `Not merged by the bot: ${verdict.reason}. It needs at least one check reported and all passing. It stays open for a person.`;
    runGh('pr', 'comment', pr, '--repo', repo, '--body', reason);
    return { merged: false, reason };
  }
  try {
    runGh('pr', 'merge', pr, '--repo', repo, `--${merge}`, '--delete-branch');
  } catch (error) {
    runGh('pr', 'comment', pr, '--repo', repo, '--body', `Not merged by the bot: its checks passed, but the merge failed: ${error.message}. It stays open for a person.`);
    throw error;
  }
  return { merged: true, reason: verdict.reason };
}

/** The value after an option, `null` if the option is absent, `undefined` if it has no value. */
function optionValue(commandLine, name) {
  const index = commandLine.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = commandLine[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE = {
  try: 'try --game <dir> --root <root> --commit <hash> --from <game-kit dir>',
  'merged-pull': 'merged-pull --pulls <file> --sha <hash>',
  decide: 'decide --pulls <file> --sha <hash> --files <file> [--output <file>]',
  'move-pin': 'move-pin --game <dir> --root <root> --commit <hash> --from <game-kit dir> [--output <file>] [--summary <file>]',
  'open-pr': 'open-pr --repo <owner/name> --base <branch> --head <branch> --commit <hash> --decision <json> --kit-repo <owner/name> [--output <file>]',
  finish: 'finish --repo <owner/name> --pr <address> --decision <json> --merge <method> [--timeout-seconds <n>] [--poll-seconds <n>] [--summary <file>]',
};

function requiredOption(commandLine, name) {
  const value = optionValue(commandLine, name);
  if (typeof value !== 'string') {
    const command = commandLine[0];
    throw new CannotTell(`${command} needs ${name} <value>. Usage: node tools/games.mjs ${USAGE[command]}`);
  }
  return value;
}

/** An option that may be left out. A name given with no value is still an error. */
function optional(commandLine, name) {
  const value = optionValue(commandLine, name);
  return value === null ? undefined : requiredOption(commandLine, name);
}

function seconds(commandLine, name, fallback) {
  const value = optional(commandLine, name);
  if (value === undefined) {
    return fallback * 1000;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new CannotTell(`${name} must be a number of seconds, not "${value}"`);
  }
  return number * 1000;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CannotTell(`cannot read ${path}: ${error.message.split('\n')[0]}`);
  }
}

function readLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  } catch (error) {
    throw new CannotTell(`cannot read ${path}: ${error.message.split('\n')[0]}`);
  }
}

function main(commandLine) {
  const gamesFile = optionValue(commandLine, '--games');
  if (gamesFile === undefined) {
    throw new CannotTell('pass --games <file>');
  }
  const command = commandLine[0];
  if (command === 'matrix') {
    console.log(JSON.stringify(readGames(gamesFile ?? GAMES_FILE)));
    return 0;
  }
  if (command === 'try') {
    return tryKitInGame({
      game: requiredOption(commandLine, '--game'),
      root: requiredOption(commandLine, '--root'),
      commit: requiredOption(commandLine, '--commit'),
      from: requiredOption(commandLine, '--from'),
    });
  }
  if (command === 'merged-pull') {
    const pull = mergedPullRequest(readJsonFile(requiredOption(commandLine, '--pulls')), requiredOption(commandLine, '--sha'));
    if (pull !== null) {
      console.log(pull.number);
    }
    return 0;
  }
  if (command === 'decide') {
    const decision = decisionFor(
      readJsonFile(requiredOption(commandLine, '--pulls')),
      requiredOption(commandLine, '--sha'),
      readLines(requiredOption(commandLine, '--files')),
    );
    const line = JSON.stringify(decision);
    console.log(line);
    const output = optional(commandLine, '--output');
    if (output) {
      appendFileSync(output, `decision=${line}\n`);
    }
    return 0;
  }
  if (command === 'move-pin') {
    movePin({
      game: requiredOption(commandLine, '--game'),
      root: requiredOption(commandLine, '--root'),
      commit: requiredOption(commandLine, '--commit'),
      from: requiredOption(commandLine, '--from'),
      output: optional(commandLine, '--output'),
      summary: optional(commandLine, '--summary'),
    });
    return 0;
  }
  if (command === 'open-pr') {
    const url = openPinMove({
      repo: requiredOption(commandLine, '--repo'),
      base: requiredOption(commandLine, '--base'),
      head: requiredOption(commandLine, '--head'),
      commit: requiredOption(commandLine, '--commit'),
      decision: parseDecision(requiredOption(commandLine, '--decision')),
      kitRepo: requiredOption(commandLine, '--kit-repo'),
    });
    console.log(url);
    const output = optional(commandLine, '--output');
    if (output) {
      appendFileSync(output, `url=${url}\n`);
    }
    return 0;
  }
  if (command === 'finish') {
    const repo = requiredOption(commandLine, '--repo');
    const pr = requiredOption(commandLine, '--pr');
    const result = finishPinMove({
      repo,
      pr,
      decision: parseDecision(requiredOption(commandLine, '--decision')),
      merge: requiredOption(commandLine, '--merge'),
      timeoutMs: seconds(commandLine, '--timeout-seconds', 30 * 60),
      pollMs: seconds(commandLine, '--poll-seconds', 30),
    });
    const line = result.merged ? `merged ${pr}: ${result.reason}` : `left ${pr} open: ${result.reason}`;
    console.log(`games.mjs: ${line}`);
    const summary = optional(commandLine, '--summary');
    if (summary) {
      appendFileSync(summary, `- ${repo}: ${line}\n`);
    }
    return 0;
  }
  throw new CannotTell(`pass a command: matrix, ${Object.values(USAGE).join(', or ')}`);
}

// Run only as a command, not when a test imports the functions above.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // One line and no stack trace, whatever went wrong.
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.error(`games.mjs: ${message}`);
    process.exitCode = 2;
  }
}
