// Shows one of a game's declared screens at a time, keeps the URL fragment and
// the browser's history in step with it, and moves focus to it. A screen change
// is an instant swap, as a page load is. It scrolls the page only when none of
// the game is on screen to see the change, unless the game sets
// `scrollWhenTopHidden` and the game's top is out of sight.
//
// Each screen has an address, the part of the URL after `#`. Going to a screen
// adds a history entry (or replaces the current one, for a screen that says
// so), and the Back and Forward buttons, a link to a fragment and a page load
// all arrive at the screen whose address the URL then holds.

export interface ScreenView {
  /** The screen's root element. The kit puts it in the page and removes it on leave. */
  element: HTMLElement;
  /** Where focus goes on arrival. Default: the screen's first heading. */
  focusTarget?: HTMLElement;
  /** Called once when the screen is left. */
  leave?(): void;
}

export interface ScreenDef {
  id: string;
  /** Fragment path, for example '/levels'. */
  address: string;
  /** May a page load, Back or Forward arrive here? */
  linkable: boolean;
  /** Does this screen replace the previous history entry instead of adding one? */
  replacesPrevious: boolean;
  /** Build the screen. `go` moves to another screen. */
  enter(params: unknown, go: Navigate): ScreenView;
}

export type Navigate = (id: string, params?: unknown) => void;

export interface Screens {
  current(): string;
  go: Navigate;
  dispose(): void;
}

export type ScreensEnvironment = Pick<
  Window,
  'history' | 'location' | 'innerHeight' | 'addEventListener' | 'removeEventListener'
>;

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
/** The address a URL with no fragment stands for. */
const HOME_ADDRESS = '/';

export function createScreens(config: {
  root: HTMLElement;
  /**
   * What is brought on screen when a screen arrives and none of it can be
   * seen. Default: the root. A game whose screens are layers over one picture
   * names the box that holds the picture.
   */
  scrollTarget?: HTMLElement;
  /**
   * Also bring the scroll target to the top when a screen arrives with the
   * target's top above the window, or under a host's sticky bar, though some
   * of it can be seen. For a game whose screens differ in height: after a
   * tall screen read from its bottom, a short one would otherwise arrive with
   * its heading out of sight. The bar's height is the scroll target's own
   * `scroll-margin-top`, the margin the browser keeps above the target when
   * it scrolls there. The host contract puts that margin on the host's
   * element and it is not inherited, so a game whose root sits inside the
   * host's element names the host's element as `scrollTarget`; otherwise the
   * bar counts as nothing.
   * Default: false, so a game whose screens share one stage is never scrolled
   * while any of it is in view.
   */
  scrollWhenTopHidden?: boolean;
  screens: readonly ScreenDef[];
  /** Where a bad or unlinkable address lands. */
  fallback: string;
  /** Told after every change, so the game can gate the clock and keys. */
  onChange(current: string, previous: string | null): void;
  /** Injected so tests need no browser. */
  environment: ScreensEnvironment;
}): Screens {
  const { root, screens, onChange, environment } = config;
  const scrollTarget = config.scrollTarget ?? root;
  let currentId: string | null = null;
  let currentView: ScreenView | null = null;
  let currentSection: HTMLElement | null = null;
  let disposed = false;

  const definitionOf = (id: string): ScreenDef => {
    const definition = screens.find((screen) => screen.id === id);
    if (!definition) {
      throw new Error(`Unknown screen "${id}"`);
    }
    return definition;
  };
  const fallback = definitionOf(config.fallback);

  const leaveCurrent = (): void => {
    currentView?.leave?.();
    currentSection?.remove();
    currentView = null;
    currentSection = null;
  };

  /** Is any part of the scroll target on screen now? */
  const isInView = (): boolean => {
    const box = scrollTarget.getBoundingClientRect();
    return box.bottom > 0 && box.top < environment.innerHeight;
  };

  /** Is the scroll target's top above the window, or under the host's sticky bar? */
  const isTopHidden = (): boolean => {
    const view = scrollTarget.ownerDocument.defaultView;
    const bar = view ? Number.parseFloat(view.getComputedStyle(scrollTarget).scrollMarginTop) || 0 : 0;
    // One pixel of slack, so a target that sits exactly under the bar counts as seen.
    return scrollTarget.getBoundingClientRect().top < bar - 1;
  };

  const show = (definition: ScreenDef, params: unknown, moveFocus: boolean): void => {
    const previousId = currentId;
    leaveCurrent();

    const view = definition.enter(params, go);
    const section = root.ownerDocument.createElement('section');
    section.dataset.screen = definition.id;
    section.append(view.element);
    root.append(section);
    currentId = definition.id;
    currentView = view;
    currentSection = section;

    if (moveFocus) {
      // A visitor who can already see the game must not have the page moved
      // under them, by the scroll or by the focus, unless the game sets
      // `scrollWhenTopHidden` and its top is out of sight. One who has
      // scrolled away from all of it is brought back to it.
      const inView = isInView();
      if (!inView || (config.scrollWhenTopHidden === true && isTopHidden())) {
        scrollTarget.scrollIntoView({ block: 'start' });
      }
      // Focus may scroll the page only when none of the game was in view. When
      // the game's top was brought back, the page is where it should be, and a
      // game that keeps the old screen on the page for a moment would have
      // focus scroll down to a heading the old screen still pushes out of sight.
      focusOn(view.focusTarget ?? section.querySelector<HTMLElement>(HEADING_SELECTOR), inView);
    }
    onChange(definition.id, previousId);
  };

  // The state of every entry is `null`: the fragment is the state. A host's
  // router may keep its own markers in `history.state`, and an entry that
  // copied them would be taken for one of the router's own.
  const fragmentOf = (definition: ScreenDef): string => `#${definition.address}`;

  const go: Navigate = (id, params) => {
    if (disposed) {
      return;
    }
    const definition = definitionOf(id);
    if (definition.replacesPrevious) {
      environment.history.replaceState(null, '', fragmentOf(definition));
    } else {
      environment.history.pushState(null, '', fragmentOf(definition));
    }
    show(definition, params, true);
  };

  /**
   * The screen the URL now names. The one rule for an address that cannot be
   * arrived at, because its screen is not linkable or no screen has it: the
   * entry is replaced by the fallback's.
   */
  const screenAtAddress = (): ScreenDef => {
    const address = environment.location.hash.replace(/^#/, '') || HOME_ADDRESS;
    const definition = screens.find((screen) => screen.address === address);
    if (definition !== undefined && definition.linkable) {
      return definition;
    }
    environment.history.replaceState(null, '', fragmentOf(fallback));
    return fallback;
  };

  // Back, Forward and a link to a fragment all change the URL first and say so here.
  const onPopState = (): void => show(screenAtAddress(), undefined, true);
  environment.addEventListener('popstate', onPopState);

  // The first screen is shown as part of the page loading, and a page must not
  // grab focus or scroll before the visitor has done anything.
  show(screenAtAddress(), undefined, false);

  return {
    current() {
      return currentId ?? fallback.id;
    },
    go,
    dispose() {
      if (disposed) {
        return;
      }
      environment.removeEventListener('popstate', onPopState);
      leaveCurrent();
      disposed = true;
    },
  };
}

/** Move focus to `target`. `holdScroll` stops the browser scrolling the page to show it. */
function focusOn(target: HTMLElement | null, holdScroll: boolean): void {
  if (!target) {
    return;
  }
  // A heading cannot take focus unless it is told it may. -1 lets a script
  // focus it without adding it to the Tab order.
  if (!target.hasAttribute('tabindex') && target.matches(HEADING_SELECTOR)) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: holdScroll });
}
