# game-kit

The shared kit for ORC PUNK's web games, in its own repo. Three games use it: Cemetery Security
(`web/kit/KIT_SOURCE.json` on its `dev` branch), Into The Dark (`kit/KIT_SOURCE.json`), and Orkid
Garden (`web/kit/KIT_SOURCE.json`). None installs it. Each copies the kit's files in at a pinned
commit and checks the copy by hash in its own `npm run check`. Into The Dark and Orkid Garden (since
OrkidGarden-Game#182) run the `kit-bump` workflow, which moves that pin to `main` here on its own.
Cemetery Security moves its pin by hand for now: its workflow file sits only on `dev`, where a
schedule never fires (as of its `dev` at `1f22c72`, 2026-10-28), which cemetery-security#763
tracks. Each pin file names the commit a game is on, so check there rather than trusting this
paragraph. The repo is public: nothing personal or confidential goes in it. The plan is
`specs/game-kit.md`; `README.md` holds the change flows and what a kit pull request must contain.

## Rules for this repo

- **`kit/` and `testing/` are copied into every game byte for byte, and hold nothing else.** No pin
  file, no notes, no file a game should not receive. `tools/sync-kit.mjs` is copied too; its test is
  not.
- **A change to `kit/` or `testing/` is a change to every game.** Make it only as a kit pull request
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
  issue. The bot that moves a pin runs in the game that has it, from `tools/kit-bump.mjs` here; a
  game without the bot moves its pin in a pull request of its own.

## The merge rule

- This repo merges with a merge commit only. Never squash, never rebase: both make new commit hashes
  and leave the commit a game tested on no branch.
- Kit first, then game. A game's pin names only commits on `main` here. Where the `kit-bump`
  workflow runs, it moves the pin after a kit change merges, and holds the move for the owner when
  the change reached `main` without a pull request, is `BREAKING:`, or touches `kit/screens.ts` or
  `kit/page.ts` without the `additive` label. Where the pin moves by hand, whoever opens the
  pin-move pull request applies the same hold: say in its body whether any kit change since the old
  pin meets one of those three conditions, and if one does, leave the pull request for the owner to
  merge.
- Never force-push or rebase a kit branch a game may be pinned to. Answer review by adding commits;
  never reorder a branch.
- Never force-push `main`.

The tool's on-main check (`--from --check`) is evidence for the owner. It is not a gate; the merge
order is the control.
