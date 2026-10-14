// Shows one of a game's declared screens at a time, keeps the URL fragment and
// the browser's history in step with it, and moves focus to it. A screen change
// is an instant swap, as a page load is. It scrolls the page only when none of
// the game is on screen to see the change.
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
      // under them, by the scroll or by the focus. One who has scrolled away
      // from all of it is brought back to it.
      const inView = isInView();
      if (!inView) {
        scrollTarget.scrollIntoView({ block: 'start' });
      }
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
