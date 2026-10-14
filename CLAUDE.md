# game-kit

The shared kit for ORC PUNK's web games, in its own repo. Two games use it: Cemetery Security and
Into The Dark. Neither installs it. Each copies the kit's files in at a pinned commit and checks the
copy by hash in its own `npm run check`, and each game's own `kit-bump` workflow moves that pin to
`main` here on its own. The repo is public: nothing personal or confidential goes in it. The plan is `specs/game-kit.md`; `README.md` holds the
change flows and what a kit pull request must contain.

## Rules for this repo

- **`kit/` and `testing/` are copied into every game byte for byte, and hold nothing else.** No pin
  file, no notes, no file a game should not receive. `tools/sync-kit.mjs` is copied too; its test is
  not.
- **A change to `kit/` or `testing/` is a change to both games.** Make it only as a kit pull request
  that carries the seven items in the README. Do not reformat or lint-fix a kit file in passing: if
  lint or `tsc` complains about one and the behaviour is right, change the config.
- **The kit knows no game.** Nothing under `kit/`, `testing/` or `tools/` imports from outside this
  repo or names a game. Three imported files still carry Cemetery Security's paths, on purpose: the
  test titles in `kit/host.test.ts` and `kit/boundaries.test.ts`, and the fixture paths in
  `testing/imports.test.ts`. They change only when a kit pull request edits those files for another
  reason; do not fix them in passing.
- **`npm run check` must pass before any commit is offered for review**: type check, lint with zero
  warnings, tests. Dev dependencies only; `package.json` has no `dependencies` block.
- **Do not edit the game repos or the site from here.** A change they need is handed to them as an
  issue. The bot that moves their pins runs in each game, from `tools/kit-bump.mjs` here.

## The merge rule

- This repo merges with a merge commit only. Never squash, never rebase: both make new commit hashes
  and leave the commit a game tested on no branch.
- Kit first, then game. A game's pin names only commits on `main` here. Each game's `kit-bump`
  workflow moves its pin after a kit change merges, and holds the move for the owner when the change
  is `BREAKING:` or touches `kit/screens.ts` or `kit/page.ts` without the `additive` label.
- Never force-push or rebase a kit branch a game may be pinned to. Answer review by adding commits;
  never reorder a branch.
- Never force-push `main`.

The tool's on-main check (`--from --check`) is evidence for the owner. It is not a gate; the merge
order is the control.
