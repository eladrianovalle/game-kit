# The host contract

```ts
// web/kit/host.ts — the whole contract. A host needs nothing else.

export interface GameResult {
  outcome: 'won' | 'lost';
  score: number;
}

export interface MountOptions {
  /** Called every time a run ends and the results screen shows. May fire many times per mount. */
  onFinished?: (result: GameResult) => void;
}

export interface MountedGame {
  /** Resolves when the first screen is visible and usable. Rejects if the game cannot start. */
  ready: Promise<void>;
  /** Remove everything the game added. Works at any time, including before `ready`. Safe to call twice. */
  unmount(): void;
}

/** Returns at once. Loading continues in the background and is reported through `ready`. */
export type Mount = (element: HTMLElement, options?: MountOptions) => MountedGame;
```

```ts
// web/game/main.ts — the build's only export
export const mount: Mount;
```

A host does this and nothing else:

```ts
const { mount } = await import(`${basePath}/games/<game>/game.js`);
const game = mount(element, { onFinished: (result) => { /* optional */ } });
// later, when the page goes away:
game.unmount();
```

`mount` is synchronous on purpose. A React host in development runs an effect, cleans it up and
runs it again; a visitor can also leave before loading finishes. In both cases the host needs a
handle it can call `unmount` on before anything has loaded. What `ready` does after an early
`unmount` (reject or stay pending) is decided by the first unit and pinned in its test; either
way nothing is added to the page afterwards.

The result names no Level and no wave, because the kit knows no game. The Results screen reads
those from the rules state.

**What the game is promised (the host's side).**

1. **The element.** An empty block element, already in the document, as wide as the host wants
   the game to be, with no fixed height and no `overflow` clipping on it or its ancestors. It
   carries the font and colour the game should inherit.
2. **The document scrolls.** The game's page uses a layout where the window is the scroller. If
   the host has sticky chrome above the game, it sets `scroll-margin-top` on the element to that
   chrome's height. That one CSS property is how the game learns how much of the viewport is its
   own.
3. **The URL fragment.** On the game's page the part of the URL after `#` belongs to the game.
   The host does not use it and does not remount the game when it changes.
4. **Same address.** `game.js`, `game.css` and `assets/` are served side by side from the host's
   own origin.
5. **Unmount on leave.** A host that navigates without reloading calls `unmount()` when the page
   goes away, and before mounting again.

**What the game promises the host.**

1. **It stays inside its element.** Every node it creates is under the element. It adds nothing
   to `<head>` or `<body>`, sets no class or style on `<html>` or `<body>`, and after `unmount`
   the element is empty again.
2. **Theme by inheritance.** Screen text takes `color` and `font` from the element. Borders and
   tints are built from `currentColor`. The playfield keeps its own dark palette.
3. **Keys.** It takes keys only on the play screen while a run is live, only the keys it has
   bound, never with Ctrl, Alt or Meta held. On every other screen the keyboard is the page's.
4. **Focus.** It moves focus only inside its element and only when its own screen changes. It
   never traps Tab.
5. **Scrolling.** It never locks the document. On the play screen it makes itself exactly as tall
   as the viewport it was given.
6. **History.** It adds history entries only for its own screens, on the current page.
7. **No surprises on load.** No sound, no full screen, no focus grab until the player acts.
