// Page manners: how much of the screen play may use, how large the playfield can
// be drawn inside it, full screen, whether the visitor is using touch, whether
// they have asked for less motion, and staying silent until they act.

import { createDisposer, type Disposer } from './lifecycle';

/**
 * The height play may use: the viewport less the host's sticky chrome, which
 * the host reports as `scroll-margin-top` on the game's element. Pure.
 */
export function playRegionHeight(viewportHeight: number, scrollMarginTop: number): number {
  return Math.max(viewportHeight - scrollMarginTop, 0);
}

/**
 * The largest size at the playfield's own shape that fits the region once
 * `reservedHeight` of it has gone to the page's controls. Pure.
 */
export function fitPlayfield(
  region: { width: number; height: number },
  playfield: { width: number; height: number },
  reservedHeight: number,
): { cssWidth: number; cssHeight: number } {
  const freeHeight = Math.max(region.height - reservedHeight, 0);
  const scale = Math.min(region.width / playfield.width, freeHeight / playfield.height);
  // Multiplying back can land a hair over the limit it was divided from.
  return {
    cssWidth: Math.min(playfield.width * scale, region.width),
    cssHeight: Math.min(playfield.height * scale, freeHeight),
  };
}

export interface PlayRegion {
  /** The height play may use, in CSS pixels, as last measured. */
  height(): number;
  /** Measure again now. Resizes and rotations are measured without being asked. */
  measure(): void;
  dispose(): void;
}

/**
 * Keeps the CSS variable `--play-region-height` on the game's root equal to the
 * height play may use, so the stylesheet can make the play screen exactly that
 * tall.
 */
export function trackPlayRegion(config: {
  /** The host's element, which carries `scroll-margin-top`. */
  hostElement: HTMLElement;
  /** The game's own root, where the variable is written. */
  root: HTMLElement;
  view: Pick<Window, 'innerHeight' | 'getComputedStyle' | 'addEventListener' | 'removeEventListener'>;
  /** True while the game fills the screen, when none of the host's chrome is on it. */
  isFullScreen(): boolean;
  /** Told after every measurement that changed the height. */
  onChange(height: number): void;
}): PlayRegion {
  const { hostElement, root, view, isFullScreen, onChange } = config;
  let height = -1;

  const measure = (): void => {
    // An unset scroll margin reads as '0px'; anything unreadable counts as none.
    const scrollMarginTop = isFullScreen() ? 0 : parseFloat(view.getComputedStyle(hostElement).scrollMarginTop) || 0;
    const measured = playRegionHeight(view.innerHeight, scrollMarginTop);
    if (measured === height) {
      return;
    }
    height = measured;
    root.style.setProperty('--play-region-height', `${height}px`);
    onChange(height);
  };

  measure();
  // Turning a phone on its side is a resize too.
  view.addEventListener('resize', measure);

  return {
    height: () => height,
    measure,
    dispose: () => view.removeEventListener('resize', measure),
  };
}

/**
 * The browser's full-screen calls. They are passed in because not every browser
 * has them, and a test page has none.
 */
export interface FullScreenApi {
  /** False where an element cannot be made full screen at all, as on an iPhone. */
  isSupported(): boolean;
  isFullScreen(element: HTMLElement): boolean;
  request(element: HTMLElement): Promise<void>;
  exit(): Promise<void>;
}

export interface FullScreen {
  isActive(): boolean;
  /** Enter full screen, or leave it. Call it from a click: a browser refuses otherwise. */
  toggle(): void;
  /** Stops listening, and leaves full screen if this element was in it. */
  dispose(): void;
}

export function createFullScreen(config: {
  /** The element that goes full screen. */
  element: HTMLElement;
  api: FullScreenApi;
  /** Where `fullscreenchange` is heard: the document. */
  changeTarget: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  /** Told whenever full screen is entered or left, by the button or by the browser's own Escape. */
  onChange(active: boolean): void;
}): FullScreen {
  const { element, api, changeTarget, onChange } = config;
  const isActive = (): boolean => api.isFullScreen(element);
  const onFullScreenChange = (): void => onChange(isActive());

  const disposer = createDisposer();
  // Teardowns run newest first, so the listener is gone before full screen is
  // left and the change that leaving makes is not reported to a game that is
  // being taken down.
  disposer.add(() => {
    if (isActive()) {
      void api.exit().catch(() => {});
    }
  });
  changeTarget.addEventListener('fullscreenchange', onFullScreenChange);
  disposer.add(() => changeTarget.removeEventListener('fullscreenchange', onFullScreenChange));

  return {
    isActive,
    toggle() {
      // A browser may refuse either way. Then nothing changes and no
      // `fullscreenchange` comes, so there is nothing to undo.
      const change = isActive() ? api.exit() : api.request(element);
      void change.catch(() => {});
    },
    dispose: () => disposer.dispose(),
  };
}

/**
 * Calls `onTouch` once, as soon as the visitor is known to be using touch: at
 * once if the device's main pointer is coarse (a finger), and otherwise on the
 * first touch, or when the device changes to a coarse pointer.
 */
export function watchForTouch(config: {
  view: Pick<Window, 'matchMedia' | 'addEventListener' | 'removeEventListener'>;
  onTouch(): void;
}): Disposer {
  const { view, onTouch } = config;
  let reported = false;
  const report = (): void => {
    if (!reported) {
      reported = true;
      onTouch();
    }
  };

  const coarsePointer = view.matchMedia('(pointer: coarse)');
  const onPointerKindChange = (): void => {
    if (coarsePointer.matches) {
      report();
    }
  };

  const disposer = createDisposer();
  coarsePointer.addEventListener('change', onPointerKindChange);
  disposer.add(() => coarsePointer.removeEventListener('change', onPointerKindChange));
  // Passive: the game only wants to know a touch happened, and must not hold up the page's scrolling to ask.
  view.addEventListener('touchstart', report, { passive: true });
  disposer.add(() => view.removeEventListener('touchstart', report));

  onPointerKindChange();
  return disposer;
}

/**
 * Has the visitor asked their device for less motion? A game reads this once,
 * when a run starts, so the answer cannot change under a run that is being played.
 */
export function prefersReducedMotion(view: Pick<Window, 'matchMedia'>): boolean {
  return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** What the unlock needs of a browser's `AudioContext`. A game asks for the rest of it. */
export type UnlockableSoundContext = Pick<AudioContext, 'state' | 'resume' | 'close'>;

/**
 * Keeps a game silent until the player acts, because a browser refuses sound
 * before that and a page should not make any unasked. Nothing is created when
 * this is called. The first key or pointer gesture inside the game creates one
 * sound context, resumes it and hands it to `onUnlock`. No later gesture
 * creates another.
 *
 * A browser may refuse to resume on a gesture it does not count as the visitor
 * acting, such as a finger going down before it has come up. Safari on an
 * iPhone counts only a finger lifting (`touchend`) or the click that follows,
 * and may suspend a running context again when a call or another app takes
 * the sound. So every gesture, those included, resumes a context that is not
 * running.
 *
 * Disposing stops listening and closes the context, if one was created.
 */
export function unlockSoundOnFirstGesture<Context extends UnlockableSoundContext>(config: {
  /** Where key presses are heard: the window. */
  keyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** The game's root. Only pointer gestures on it count. */
  pointerTarget: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>;
  /** Keys are heard page-wide, so the game says which presses are its own. */
  isKeyInsideGame(event: KeyboardEvent): boolean;
  /** Make the sound context. Passed in because a test page has none. */
  createContext(): Context;
  /** Told once, with the context, on the gesture that created it. */
  onUnlock(context: Context): void;
}): Disposer {
  const { keyTarget, pointerTarget, isKeyInsideGame, createContext, onUnlock } = config;
  let context: Context | null = null;

  const onGesture = (): void => {
    if (context === null) {
      context = createContext();
      onUnlock(context);
    }
    if (context.state !== 'running') {
      // A refusal leaves the context as it was, and the next gesture asks again.
      void context.resume().catch(() => {});
    }
  };
  const onKeyDown = (event: Event): void => {
    if (isKeyInsideGame(event as KeyboardEvent)) {
      onGesture();
    }
  };

  const disposer = createDisposer();
  disposer.add(() => {
    if (context !== null) {
      void context.close().catch(() => {});
    }
  });
  keyTarget.addEventListener('keydown', onKeyDown);
  disposer.add(() => keyTarget.removeEventListener('keydown', onKeyDown));
  // A mouse counts as the visitor acting when its button goes down, a finger when it lifts; Safari on an iPhone
  // counts only `touchend` and `click`.
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click'] as const) {
    pointerTarget.addEventListener(type, onGesture);
    disposer.add(() => pointerTarget.removeEventListener(type, onGesture));
  }
  return disposer;
}
