# Reviewer concerns: gk_pin_bumps

## 1. A later kit merge closes a held pin move that carries the owner's adaptation edits

- **Concern:** `openPinMove` closes every other open `kit/*` pull request ("Replaced by ..., which moves the pin to a newer game-kit commit"). In flow (b) the owner pushes a game's adaptation edits onto the held `kit/<short>` pin move. If any other kit change merges before the owner merges it, the bot closes that pull request, and the new pin move (built from the game's base branch) lacks those edits, so its checks fail and it is left open. The edits survive only on the closed branch.
- **Why unresolved:** out_of_unit_scope. The spec (failure table: "The newer pin move replaces it: the bot closes the older one") asks for exactly this behaviour.
- **Follow-up:** amend the spec: skip closing (and comment instead) when the older pin move has commits not authored by the bot, or say in README flow (b) that edits must be cherry-picked onto the newer pin move.
