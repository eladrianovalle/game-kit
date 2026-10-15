# game-kit

The shared kit for ORC PUNK's web games: keyboard and touch input, the list of actions both feed, the
game clock, moving between screens, the agreement between a game and the page that shows it, and
cleaning up when the player leaves.

Games do not install the kit. Each game copies the kit's files into its own repo at one exact commit
of this repo, commits them, and keeps a small file, the pin, that records that commit and a SHA-256
hash of every copied file. The game's own `npm run check` recomputes the hashes and fails if a copied
file was edited by hand. So the kit is changed in one place, here, and a game changes only through a
pull request in its own repo. Every game runs the latest kit: each game's own `kit-bump` workflow
moves its pin to this repo's `main` after a kit change merges.

The full plan is `specs/game-kit.md`.

## What is here

| Path | What it is | Copied into games |
|---|---|---|
| `kit/` | The kit: 17 files with no outside dependency. | Yes |
| `testing/` | The 8 helper files the kit's tests import. | Yes |
| `tools/sync-kit.mjs` | Copies a pinned commit into a game and checks the copy. | Yes |
| `tools/sync-kit.test.ts` | The tool's test. Runs here only. | No |
| `CONTRACT.md` | What a host page and a game promise each other. | No, games and the site link to it |
| `tools/kit-bump.mjs` | The bot that moves a game's pin, run by each game's workflow from a clone of `main`. Its test is beside it. | No |
| `templates/kit-bump.yml` | The workflow a game copies once to run the bot. | Once, by hand |

Everything under `kit/` and `testing/` is copied into every game byte for byte, and nothing else
lives in those two folders. That is why this repo has no `kit/KIT_SOURCE.json`: a game's pin sits at
that path.

`npm run check` is this repo's one check: type check, lint with zero warnings, and the tests. Node
22.12 or newer.

## How a game adopts the kit

Run these in the folder that will hold `kit/`, `testing/` and `tools/` (the game's root, or `web/` in
Cemetery Security). `<game-kit>` is the path to a fetched clone of this repo.

1. Write `kit/KIT_SOURCE.json`, with `commit` set to a full commit hash on this repo's `main`:

   ```json
   {
     "_comment": "Where the vendored kit comes from. The files listed under sha256 are byte-for-byte copies from this commit of game-kit. Change none of them by hand: change the kit in game-kit, move the commit here, and run `node tools/sync-kit.mjs --from <path to a game-kit checkout>`.",
     "repository": "git@github.com:eladrianovalle/game-kit.git",
     "commit": "<40 hex characters: a commit on game-kit main>",
     "copies": [
       { "from": "kit", "to": "kit" },
       { "from": "testing", "to": "testing" },
       { "from": "tools/sync-kit.mjs", "to": "tools/sync-kit.mjs" }
     ]
   }
   ```

   `repository` is for people; the tool never reads it. `to` paths are relative to the folder above
   `tools/`. The tool writes the `sha256` block; never write or edit it by hand.
2. Copy the tool in, with the commit hash typed out:
   `git -C <game-kit> show <commit>:tools/sync-kit.mjs > tools/sync-kit.mjs`. Check the file is not
   empty.
3. `node tools/sync-kit.mjs --from <game-kit>`. It copies the files and records their hashes.
4. Add `node tools/sync-kit.mjs --check` to the game's `npm run check`.
5. Commit the copied files and the pin together.

To move to a newer kit later, by hand (the bot does this for every game on every merge): set `commit`
to a newer commit on `main`, run step 3, run the game's `npm run check`, and play the game. If
`tools/sync-kit.mjs` was among the copied files, run the command once more, so the new tool has done
the copy.

A sync writes the files that exist at the pinned commit. A file the last sync recorded that the kit
has since renamed or removed is deleted, if it is unchanged; if it was edited by hand, the sync fails
and writes nothing. A file the kit never copied is not touched. A sync overwrites an uncommitted hand
edit to a copied file without warning.

## The sync tool

| Command | What it does |
|---|---|
| `node tools/sync-kit.mjs --from <game-kit>` | Copies the pinned commit in and records the hashes. |
| `node tools/sync-kit.mjs --from <game-kit> --check` | Changes nothing. Fails if any file differs from the pinned commit, or if the pinned commit is not on `origin/main` of that clone. |
| `node tools/sync-kit.mjs --check` | Changes nothing. Fails if any file differs from its recorded hash. Needs no clone of this repo, so it runs in a game's CI. |

It reads the clone through git objects only, never its working files, so the clone's branch and
uncommitted work do not matter. It reads the clone as last fetched, so fetch first.

| Exit code | Meaning |
|---|---|
| 0 | All is as it should be. |
| 1 | A file differs, or, for `--from --check` only, the pin is not on `main`. |
| 2 | The tool cannot tell: a bad pin, a bad clone, a commit or path it cannot find. Nothing was written. |

## The merge rule

- A game may be built and shown green against a kit branch commit, as evidence for the kit pull
  request.
- A game's pull request merges only after the kit change is on this repo's `main`.
- This repo merges with a merge commit, never a squash and never a rebase. Both make new commit
  hashes and leave the commit the game tested on no branch.
- A kit branch is never force-pushed or rebased once a game may be pinned to it. Review fixes are
  added as new commits.
- The owner merges, kit first, then the game.

**The on-main check is evidence, not a gate.** `--from --check` says whether a game's pin is on
`origin/main`, and its output is pasted into the game's pull request for the owner to read. Nothing
enforces it: a game's `npm run check` never reads this repo, and its hash check knows nothing of
`main`. A pin the `kit-bump` bot moves always names `main`'s head. For a pin moved by hand, the
control is the order the owner merges in.

## What a kit pull request must contain

Write it for a reader who knows neither game.

1. What changes for a game that uses the kit: behaviour before and after, and which files.
2. Why: which game needs it, with a link to that game's pull request or issue.
3. Breaking or not. Breaking means a game must edit its own code to adopt, or will behave differently
   without editing anything. If the change is additive, name the default that keeps the old behaviour
   (`scrollTarget` in `kit/screens.ts` is the model).
4. Evidence: the kit branch commit a game pinned and its `npm run check` result there, for every game
   the change touches. If the change can be seen or felt, also what was watched in a real browser, and
   in which game.
5. Every game: where it uses what changed, by file and quoted call, and what it must do to adopt, or
   "nothing" with the reason. A renamed or removed kit file is named here: the sync deletes the old
   copy, so name anything in a game that still imports it.
6. Whether `CONTRACT.md` changes. If it does, the site is a party; link the site issue.
7. The kit tests added or changed, named by the behaviour they hold.

## Changing the kit

Each game runs `templates/kit-bump.yml` as its own workflow, every hour and on demand, with its own
token. It clones this repo's `main`, runs `tools/kit-bump.mjs` from that clone, and:

1. does nothing if the pin already names `main`, or a pin move to it is already open;
2. moves the pin on a branch `kit/<short hash>` and copies the files with the game's own sync tool;
3. runs the game's own `npm run check` (in that run: a pull request opened with a repo's own token
   does not start its other workflows);
4. pushes the branch, replacing one it left earlier with no open pull request, opens a pull request
   titled "Move the kit pin to game-kit <short hash>", and closes the game's older pin moves (branches
   `kit/<short hash>`) as replaced, unless one holds someone's edits, which it comments on;
5. merges it, or leaves it open with a comment, as below.

- **Hold for the owner** if any kit change since the pin reached `main` without a pull request, has a
  title starting `BREAKING:`, or changes or renames `kit/screens.ts` or `kit/page.ts` without the label
  `additive`.
- **Leave it open** if the check failed, with the end of its output in a comment. The run shows red.
- **Merge** otherwise, with that game's merge method.

To add a game: copy `templates/kit-bump.yml` to its `.github/workflows/kit-bump.yml`, set `KIT_ROOT`,
`KIT_BRANCH` and `KIT_MERGE`, and turn on "Allow GitHub Actions to create and approve pull requests"
in its Actions settings.

**Marking a change `additive`.** Add the label `additive` to the kit pull request before it merges,
when an existing function called with the same arguments behaves as before, and name the default
that keeps the old behaviour under item 3. The label only matters for `kit/screens.ts` and
`kit/page.ts` (not their test files), whose behaviour shows only in a real browser. A `BREAKING:`
title holds every pin move, label or not.

### (a) A kit change one game needs

1. The game's agent branches this repo from `origin/main` in its own clone, makes the change with
   tests, gets `npm run check` green, and opens the kit pull request with the seven items above. The
   change is additive: an existing function called with the same arguments behaves as before.
   If it touches `kit/screens.ts` or `kit/page.ts`, label the pull request `additive`.
2. The asking game's agent pins the kit branch in a draft game pull request, runs `npm run check`
   there, and plays it if the change can be seen or felt. That is item 4.
3. The owner merges the kit pull request with a merge commit.
4. Within the hour, each game's `kit-bump` workflow moves its pin and merges the move once that game's
   own check passes. Every game's repo is now on the change. The bot's merge starts no workflow, so
   nothing deploys it until the game's workflows next run.
5. The asking game uses the new code in an ordinary pull request of its own. Its pin has already
   moved.

### (b) A change that is not additive

Prefer an additive change with a default that keeps the old behaviour: it costs one pull request
instead of one per game. When that cannot be done:

1. Follow (a), with the kit pull request's title starting `BREAKING:`.
2. Under item 5, name the edits each game needs.
3. On merge each game's `kit-bump` workflow still opens its pin move, but merges none of them: each
   waits for the owner.
4. The edits each game needs are pushed to that game's pin-move pull request, so the pin and the code
   move together. The owner merges it once its checks pass. If a newer kit change merges first, the
   bot leaves this pull request open and comments on it: carry the edits onto the newer pin move.

### (c) A hand edit caught by the hash check

A game's `npm run check` fails with `these files differ from the hashes recorded for <commit>`.

1. Do not sync first. A sync would overwrite the edit.
2. Save the edit, from the folder that holds `tools/` (`web/` in Cemetery Security):
   `git diff -- kit testing tools/sync-kit.mjs`. If it was already committed, compare the file with
   `git -C <game-kit> show <pinned commit>:<path>`.
3. If the edit is wanted, apply it on a branch of this repo and follow (a).
4. If it is not, `node tools/sync-kit.mjs --from <game-kit>` restores the pinned bytes.
5. Never quiet the check by editing a hash in the pin.

## Where the kit came from

The first two commits on the import branch copy the kit from `eladrianovalle/cemetery-security`, byte
for byte. Their messages name the source commits. The earlier history stays in that repo, on branch
`feat/web-game-kit` and in its pull request #735.
