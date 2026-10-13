# Reviewer concerns: gk_pad_menu_focus

## [ ] Criterion 6 has no evidence in this repo

- **Concern:** "Into The Dark's evidence pull request shows a pad moving focus on the Title screen and pressing New Game." Nothing in game-kit imports `kit/menu.ts` except `kit/menu.test.ts`, so the only proof here is a toy game under happy-dom. Real-browser behaviour (focus ring visible, a real pad, the real Title screen) is unchecked.
- **Why unresolved:** out of unit scope. The evidence lives in the Into The Dark repo and needs a browser and a pad.
- **Follow-up:** sync the kit into Into The Dark, wire `createMenuFocus` to the Title screen, and attach the recording to that pull request.
