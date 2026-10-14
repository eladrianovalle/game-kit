# game-kit

The shared kit for ORC PUNK's web games: keyboard and touch input, the list of actions both feed, the
game clock, moving between screens, the agreement between a game and the page that shows it, and
cleaning up when the player leaves.

Games do not install the kit. Each game copies the kit's files into its own repo at one exact commit
of this repo, commits them, and keeps a small file, the pin, that records that commit and a SHA-256
hash of every copied file. The game's own `npm run check` recomputes the hashes and fails if a copied
file was edited by hand. So the kit is changed in one place, here, and a game changes only when its
own agent moves its pin.

The full plan is `specs/game-kit.md`.

## What is here

| Path | What it is | Copied into games |
|---|---|---|
| `kit/` | The kit: 17 files with no outside dependency. | Yes |
| `testing/` | The 8 helper files the kit's tests import. | Yes |
| `tools/sync-kit.mjs` | Copies a pinned commit into a game and checks the copy. | Yes |
| `tools/sync-kit.test.ts` | The tool's test. Runs here only. | No |
| `CONTRACT.md` | What a host page and a game promise each other. | No, games and the site link to it |

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

To move to a newer kit later: set `commit` to a newer commit on `main`, run step 3, run the game's
`npm run check`, and play the game. If `tools/sync-kit.mjs` was among the copied files, run the
command once more, so the new tool has done the copy.

A sync writes the files that exist at the pinned commit and deletes nothing. A file the kit has
renamed or removed stays in the game until the game deletes it. A sync overwrites an uncommitted hand
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
enforces it: a game's CI cannot reach this repo, and the hash check in a game's CI knows nothing of
`main`. The control is the order the owner merges in.

## What a kit pull request must contain

Write it for a reader who knows neither game.

1. What changes for a game that uses the kit: behaviour before and after, and which files.
2. Why: which game needs it, with a link to that game's pull request or issue.
3. Breaking or not. Breaking means a game must edit its own code to adopt, or will behave differently
   without editing anything. If the change is additive, name the default that keeps the old behaviour
   (`scrollTarget` in `kit/screens.ts` is the model).
4. Evidence from the game that asked: the kit branch commit it pinned and its `npm run check` result
   there. If the change can be seen or felt, also what was watched in a real browser.
5. The other game: where it uses what changed, by file and quoted call, and what it must do to adopt,
   or "nothing" with the reason. A renamed or removed kit file is named here, because each game must
   delete its old copy by hand.
6. Whether `CONTRACT.md` changes. If it does, the site is a party; link the site issue.
7. The kit tests added or changed, named by the behaviour they hold.

## Changing the kit

### (a) A kit change one game needs

1. The game's agent branches this repo from `origin/main` in its own clone, makes the change with
   tests, gets `npm run check` green, and opens the kit pull request with the seven items above.
2. In its game, on a branch: set `commit` in the pin to the kit branch head, run
   `node tools/sync-kit.mjs --from <game-kit>` (the tool notes that the commit is not on main), run
   `npm run check`, and play the game if the change can be seen. Open the game pull request as a
   draft whose first line is "Waits on game-kit#N".
3. If review adds commits to the kit pull request, the game re-pins to the new head and syncs again.
4. The owner merges the kit pull request with a merge commit. The commit the game pinned is now on
   `main`, so the game does not re-pin.
5. The game's agent fetches this repo, runs `node tools/sync-kit.mjs --from <game-kit> --check`, and
   on exit 0 pastes the output into the game pull request and marks it ready. The owner merges.
6. The other game does nothing until it next wants a kit change. Then it moves its pin to a commit on
   `main`, syncs, runs `npm run check` and plays.

### (b) A change that breaks the other game

Prefer an additive change with a default that keeps the old behaviour. When that cannot be done:

1. Follow (a), with the kit pull request's title starting `BREAKING:`.
2. Under item 5, name the edits the other game will need.
3. When the kit pull request merges, its author opens an issue in the other game's repo with the
   commit, what changes and what to edit.
4. The other game adapts in one pull request that moves its pin and edits its code together.

The merge does not break the other game, because its pin has not moved. The cost comes later: it
cannot take any newer kit change until it has adapted, because pins move along one line of history.

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
