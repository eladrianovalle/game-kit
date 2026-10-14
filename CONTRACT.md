# The host contract

This replaces the section "The host contract" in `cemetery-security:specs/web-game-kit.md`. Where
the two differ, this file is right.

It is what a page that shows a game (the host) and the game promise each other. Games and the site
read it here; it is never copied into a game.

The types are `kit/host.ts`; that file is the contract's code.

```ts
// the game's entry file: the build's only export
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
`unmount` (reject or stay pending) is each game's to decide and to hold in its own tests; either
way nothing is added to the page afterwards.

The result names nothing that belongs to one game, such as a level, because the kit knows no
game. A game's own results screen reads those from the game's own state.

**What the game is promised (the host's side).**

1. **The element.** An empty block element, already in the document, as wide as the host wants
   the game to be, with no fixed height and no `overflow` clipping on it or its ancestors. The
   host passes no font, colour or background to the game; the element may reset all three to
   browser defaults.
2. **The document scrolls.** The game's page uses a layout where the window is the scroller. If
   the host has sticky chrome above the game, it sets `scroll-margin-top` on the element to that
   chrome's height. That one CSS property is how the game learns how much of the viewport is its
   own.
3. **The URL fragment.** On the game's page the part of the URL after `#` belongs to the game.
   The host does not use it and does not remount the game when it changes.
4. **Side by side.** `game.js`, `game.css` and `assets/` are served from one folder, which may be
   on another origin than the page. The game finds its files relative to `game.js`'s own address
   (`import.meta.url`), and the server must allow cross-origin reads.
5. **Unmount on leave.** A host that navigates without reloading calls `unmount()` when the page
   goes away, and before mounting again.

**What the game promises the host.**

1. **It stays inside its element.** Every node it creates is under the element. It adds nothing
   to `<head>` or `<body>`, sets no class or style on `<html>` or `<body>`, and after `unmount`
   the element is empty again.
2. **Its own look.** The game sets its own font, text colour and background on its root, and
   reads no CSS variable of the host's.
3. **Keys.** It takes keys only on the play screen while a run is live, only the keys it has
   bound, never with Ctrl, Alt or Meta held. On every other screen the keyboard is the page's.
4. **Focus.** It moves focus only inside its element and only when its own screen changes. It
   never traps Tab.
5. **Scrolling.** It never locks the document. On the play screen it makes itself exactly as tall
   as the viewport it was given.
6. **History.** It adds history entries only for its own screens, on the current page.
7. **No surprises on load.** No sound, no full screen, no focus grab until the player acts.
