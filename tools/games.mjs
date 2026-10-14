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
// Exit codes: 0 done; 2 this script cannot work with what it was given (one
// line on stderr, no stack trace). `try` otherwise passes on the sync tool's code.
//
// Option, used by the tests:
//   --games <file>   read this file in place of games.json

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** The value after an option, `null` if the option is absent, `undefined` if it has no value. */
function optionValue(commandLine, name) {
  const index = commandLine.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = commandLine[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function requiredOption(commandLine, name) {
  const value = optionValue(commandLine, name);
  if (typeof value !== 'string') {
    throw new CannotTell(`try needs ${name} <value>. Usage: node tools/games.mjs try --game <dir> --root <root> --commit <hash> --from <game-kit dir>`);
  }
  return value;
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
  throw new CannotTell('pass a command: matrix, or try --game <dir> --root <root> --commit <hash> --from <game-kit dir>');
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
