// Copies the shared web game kit into a game's repo from a game-kit checkout,
// at the commit pinned in kit/KIT_SOURCE.json, and nothing else. It reads the
// checkout through git objects only, so that checkout's branch and uncommitted
// work do not matter and are never touched. Every sync also records a SHA-256
// for each copied file in kit/KIT_SOURCE.json, so a hand edit can be caught
// later without the checkout.
//
//   node tools/sync-kit.mjs --from ../game-kit          copy the pinned commit in and record the hashes
//   node tools/sync-kit.mjs --from ../game-kit --check  change nothing; fail if any file differs from the pinned commit
//   node tools/sync-kit.mjs --check                     change nothing; fail if any file differs from its recorded hash
//
// A game's `npm run check` runs the last form, which needs no other checkout
// and so runs in CI too.
//
// With --from, the tool also asks whether the pinned commit is on origin/main
// of that checkout, as last fetched. That is evidence for whoever merges, not a
// gate: a plain --from still copies and only adds a note.
//
// Exit codes:
//   0  all is as it should be
//   1  a file differs, or (with --from --check) the pinned commit is not on origin/main
//   2  the tool cannot tell: a bad pin, a bad checkout, a commit or path it cannot find
//
// Paths in the pin are relative to the folder above this file's folder.
//
// Option, used by the tests:
//   --root <dir>    use another folder (and its kit/KIT_SOURCE.json) in place of the folder above tools/

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join('kit', 'KIT_SOURCE.json');
const SYNC_COMMAND = 'node tools/sync-kit.mjs --from <path to a game-kit checkout>';

/** Something the tool cannot work with. Reported as one line, exit 2. */
class CannotTell extends Error {}

/** The value after an option, `null` if the option is absent, `undefined` if it has no value. */
function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// git's own stderr is dropped everywhere: the tool reports each failure itself, in one line.
const QUIET = ['ignore', 'pipe', 'ignore'];

function gitShow(checkout, commit, path) {
  return execFileSync('git', ['-C', checkout, 'show', `${commit}:${path}`], { stdio: QUIET, maxBuffer: Infinity });
}

/** Every file under a path at a commit, as paths relative to that commit's root. */
function listFilesAt(checkout, commit, path) {
  const output = execFileSync('git', ['-C', checkout, 'ls-tree', '-r', '--name-only', commit, path], { encoding: 'utf8', stdio: QUIET });
  return output.split('\n').filter((line) => line.length > 0);
}

/** `[sourcePath, destinationPath]` for every file one `copies` entry names, the destination relative to the root. */
function filesOfCopy(checkout, commit, copy) {
  const sources = listFilesAt(checkout, commit, copy.from);
  if (sources.length === 0) {
    throw new CannotTell(`${copy.from} does not exist at ${commit}`);
  }
  const isDirectory = sources.length > 1 || sources[0] !== copy.from;
  return sources.map((source) => [source, isDirectory ? `${copy.to}/${source.slice(copy.from.length + 1)}` : copy.to]);
}

function readPin(root) {
  const pinPath = join(root, PIN_FILE);
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (error) {
    throw new CannotTell(`cannot read ${pinPath}: ${error.message.split('\n')[0]}`);
  }
  if (typeof pin?.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) {
    throw new CannotTell(`${PIN_FILE}: "commit" must be a full commit hash, 40 hex characters`);
  }
  return pin;
}

/** Whether the pinned commit is on origin/main of the checkout, as last fetched. Throws if the checkout cannot say. */
function isOnMain(checkout, commit) {
  const found = spawnSync('git', ['-C', checkout, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
  if (found.status !== 0) {
    throw new CannotTell(`${commit} is not in ${checkout}. Is that a game-kit checkout, and has it been fetched?`);
  }
  const ancestor = spawnSync('git', ['-C', checkout, 'merge-base', '--is-ancestor', commit, 'origin/main'], { stdio: 'ignore' });
  if (ancestor.status !== 0 && ancestor.status !== 1) {
    throw new CannotTell(`${checkout} has no origin/main to compare with. Is it a clone of game-kit?`);
  }
  return ancestor.status === 0;
}

/** Copy the pinned commit in and record each file's hash; or, with `check`, only list the files that differ from it. */
function syncFromCheckout({ root, checkout, check }) {
  const pin = readPin(root);
  if (!Array.isArray(pin.copies) || pin.copies.some((copy) => typeof copy?.from !== 'string' || typeof copy?.to !== 'string')) {
    throw new CannotTell(`${PIN_FILE}: "copies" must be a list of { "from", "to" } entries`);
  }
  const onMain = isOnMain(checkout, pin.commit);
  // Every entry is listed before any file is written, so a pin that names a
  // path its commit does not hold leaves the game exactly as it was.
  const files = pin.copies.flatMap((copy) => filesOfCopy(checkout, pin.commit, copy));
  const differences = [];
  const hashes = {};
  let copied = 0;
  for (const [source, destination] of files) {
    const wanted = gitShow(checkout, pin.commit, source);
    hashes[destination] = sha256(wanted);
    const destinationPath = join(root, destination);
    const current = existsSync(destinationPath) ? readFileSync(destinationPath) : null;
    if (current !== null && current.equals(wanted)) {
      continue;
    }
    if (check) {
      differences.push(destination);
      continue;
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, wanted);
    copied += 1;
  }
  if (!check) {
    writeFileSync(join(root, PIN_FILE), `${JSON.stringify({ ...pin, sha256: hashes }, null, 2)}\n`);
  }
  return { commit: pin.commit, copied, differences, onMain };
}

/** The vendored files that are missing or no longer have the hash recorded when they were last synced. */
function checkAgainstRecordedHashes({ root }) {
  const pin = readPin(root);
  if (pin.sha256 === null || typeof pin.sha256 !== 'object' || Object.keys(pin.sha256).length === 0) {
    throw new CannotTell(`${PIN_FILE} records no hashes. Run: ${SYNC_COMMAND}`);
  }
  const differences = [];
  for (const [file, recorded] of Object.entries(pin.sha256)) {
    const path = join(root, file);
    if (!existsSync(path) || sha256(readFileSync(path)) !== recorded) {
      differences.push(file);
    }
  }
  return { commit: pin.commit, copied: 0, differences, onMain: true };
}

function main() {
  const checkout = optionValue('--from');
  const check = process.argv.includes('--check');
  const root = optionValue('--root') ?? REPO_DIRECTORY;
  if (checkout === undefined || root === undefined || (checkout === null && !check)) {
    throw new CannotTell('pass --from <path to a game-kit checkout>, or --check to compare with the recorded hashes');
  }
  const result = checkout === null ? checkAgainstRecordedHashes({ root }) : syncFromCheckout({ root, checkout, check });

  if (result.differences.length > 0) {
    const comparedWith = checkout === null ? `the hashes recorded for ${result.commit}` : result.commit;
    console.error(`sync-kit.mjs: FAILED: these files differ from ${comparedWith}:`);
    for (const file of result.differences) {
      console.error(`  ${file}`);
    }
    console.error('If the change is wanted, it belongs in game-kit: save it first, then see flow (c) in the game-kit README.');
    console.error(`To discard it and restore the pinned files, run: ${SYNC_COMMAND}`);
  }
  if (check && !result.onMain) {
    const mainHead = execFileSync('git', ['-C', checkout, 'rev-parse', '--short', 'origin/main'], { encoding: 'utf8', stdio: QUIET }).trim();
    console.error(
      `sync-kit.mjs: ${result.commit} is not on origin/main of ${checkout} (origin/main there is ${mainHead}). ` +
        'Fetch that checkout and try again; if it still fails, the kit change has not merged.',
    );
  }
  if (result.differences.length > 0 || (check && !result.onMain)) {
    return 1;
  }
  console.log(check ? `sync-kit.mjs: the vendored kit files match ${result.commit}` : `sync-kit.mjs: copied ${result.copied} file(s) from ${result.commit}`);
  if (!result.onMain) {
    console.log(`sync-kit.mjs: note: ${result.commit} is not on origin/main of ${checkout}`);
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  // One line and no stack trace, whatever went wrong.
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
  console.error(`sync-kit.mjs: ${message}`);
  process.exitCode = 2;
}
