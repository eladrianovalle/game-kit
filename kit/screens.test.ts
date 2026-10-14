import { describe, expect, it } from 'vitest';
import { createFakeHistory, FAKE_WINDOW_HEIGHT } from '../testing/fake-history';
import { createFakePage, placeElement } from '../testing/fake-page';
import { createScreens, type ScreenDef } from './screens';

/** Four screens shaped like a game's: a home, a list that can be linked to, a level that cannot, and a summary that takes the level's place. */
function setUp(options: { hash?: string } = {}) {
  const { document, hostElement: root } = createFakePage();
  const history = createFakeHistory({ hash: options.hash });
  const log: string[] = [];

  const menu: ScreenDef = {
    id: 'menu',
    address: '/',
    linkable: true,
    replacesPrevious: false,
    enter(_params, go) {
      const element = document.createElement('div');
      const heading = document.createElement('h1');
      heading.textContent = 'Menu';
      const start = document.createElement('button');
      start.textContent = 'Start';
      start.addEventListener('click', () => go('level', { number: 3 }));
      element.append(heading, start);
      return { element, leave: () => log.push('left menu') };
    },
  };
  const list: ScreenDef = {
    id: 'list',
    address: '/list',
    linkable: true,
    replacesPrevious: false,
    enter() {
      const element = document.createElement('div');
      const heading = document.createElement('h1');
      heading.textContent = 'List';
      const lastChosen = document.createElement('button');
      lastChosen.dataset.role = 'last-chosen';
      element.append(heading, lastChosen);
      return { element, focusTarget: lastChosen };
    },
  };
  const level: ScreenDef = {
    id: 'level',
    address: '/level',
    linkable: false,
    replacesPrevious: false,
    enter(params) {
      const element = document.createElement('div');
      const heading = document.createElement('h2');
      heading.textContent = `Level ${(params as { number: number } | undefined)?.number}`;
      const quit = document.createElement('button');
      quit.dataset.role = 'quit';
      element.append(heading, quit);
      return { element };
    },
  };
  const summary: ScreenDef = {
    id: 'summary',
    address: '/summary',
    linkable: false,
    replacesPrevious: true,
    enter() {
      const element = document.createElement('div');
      const heading = document.createElement('h1');
      const again = document.createElement('button');
      again.dataset.role = 'again';
      element.append(heading, again);
      return { element, focusTarget: again };
    },
  };

  const screens = createScreens({
    root,
    screens: [menu, list, level, summary],
    fallback: 'list',
    onChange: (current, previous) => log.push(`${previous} -> ${current}`),
    environment: history.environment,
  });
  const shown = (): string | undefined => (root.children[0] as HTMLElement | undefined)?.dataset.screen;
  return { document, root, screens, log, history, shown };
}

describe('screens', () => {
  it('shows the first screen in one section, without moving focus', () => {
    const { document, root, screens, log } = setUp();
    expect(screens.current()).toBe('menu');
    expect(root.children.length).toBe(1);
    const section = root.children[0] as HTMLElement;
    expect(section.tagName).toBe('SECTION');
    expect(section.dataset.screen).toBe('menu');
    // A page must not grab focus before the visitor has done anything.
    expect(document.activeElement).toBe(document.body);
    expect(log).toEqual(['null -> menu']);
  });

  it('swaps to another screen, passing its params, and leaves the old one', () => {
    const { root, screens, log } = setUp();
    root.querySelector('button')!.click();
    expect(screens.current()).toBe('level');
    expect(root.children.length).toBe(1);
    expect((root.children[0] as HTMLElement).dataset.screen).toBe('level');
    expect(root.querySelector('h2')!.textContent).toBe('Level 3');
    expect(log).toEqual(['null -> menu', 'left menu', 'menu -> level']);
  });

  it('moves focus to the first heading of the screen it arrives at', () => {
    const { document, root, screens } = setUp();
    screens.go('level', { number: 1 });
    const heading = root.querySelector('h2')!;
    expect(document.activeElement).toBe(heading);
    // Focusable by script, but not a stop in the Tab order.
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('moves focus to the focus target when the screen names one', () => {
    const { document, root, screens } = setUp();
    screens.go('summary');
    expect(document.activeElement).toBe(root.querySelector('[data-role="again"]'));
  });

  it('refuses a screen that was never declared', () => {
    const { screens } = setUp();
    expect(() => screens.go('nowhere')).toThrow('Unknown screen "nowhere"');
  });

  it('on dispose leaves the current screen, empties the root and ignores later moves', () => {
    const { root, screens, log } = setUp();
    screens.dispose();
    expect(root.children.length).toBe(0);
    expect(log).toContain('left menu');
    screens.go('level', { number: 1 });
    expect(root.children.length).toBe(0);
  });
});

describe('screens and the page\'s scroll', () => {
  /** Record each time an element is brought into view, and each time focus is moved and whether the page may scroll for it. */
  function watchThePage(document: Document, elements: Record<string, HTMLElement>) {
    const scrolls: [string, unknown][] = [];
    for (const [name, element] of Object.entries(elements)) {
      element.scrollIntoView = (options?: unknown) => {
        scrolls.push([name, options]);
      };
    }
    const focuses: unknown[] = [];
    const window = document.defaultView as unknown as { HTMLElement: typeof HTMLElement };
    const focus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
      focuses.push(options);
      focus.call(this, options);
    };
    return { scrolls, focuses };
  }

  it('a screen arriving while any of the root is on screen scrolls nothing, and moves focus without scrolling', () => {
    const { document, root, screens, history } = setUp();
    // The root's top is above the window and its bottom is in it.
    placeElement(root, { left: 0, top: -300, width: 800, height: 600 });
    const { scrolls, focuses } = watchThePage(document, { root });
    screens.go('list');
    screens.go('level', { number: 1 });
    screens.go('summary');
    history.back();
    expect(scrolls).toEqual([]);
    expect(focuses).toEqual([{ preventScroll: true }, { preventScroll: true }, { preventScroll: true }, { preventScroll: true }]);
    // Focus still arrived.
    expect(document.activeElement).toBe(root.querySelector('[data-role="last-chosen"]'));
  });

  it('a screen arriving while none of the root is on screen brings the root to the top, and lets focus scroll', () => {
    for (const top of [-600, FAKE_WINDOW_HEIGHT]) {
      const { document, root, screens } = setUp();
      // Wholly above the window, then wholly below it. An edge that only touches the window's shows nothing.
      placeElement(root, { left: 0, top, width: 800, height: 600 });
      const { scrolls, focuses } = watchThePage(document, { root });
      screens.go('list');
      expect(scrolls).toEqual([['root', { block: 'start' }]]);
      expect(focuses).toEqual([{ preventScroll: false }]);
    }
  });

  /** Two screens over a root placed at `rootTop`, with the host's sticky bar given as the root's scroll-margin-top. */
  function screensWithTopHidden(rootTop: number, scrollWhenTopHidden: boolean | undefined, scrollMarginTop = '') {
    const { document, hostElement: root } = createFakePage();
    root.style.scrollMarginTop = scrollMarginTop;
    const screen = (id: string, address: string): ScreenDef => ({
      id,
      address,
      linkable: true,
      replacesPrevious: false,
      enter() {
        const element = document.createElement('div');
        element.append(document.createElement('h1'));
        return { element };
      },
    });
    const screens = createScreens({
      root,
      scrollWhenTopHidden,
      screens: [screen('menu', '/'), screen('short', '/short')],
      fallback: 'menu',
      onChange: () => {},
      environment: createFakeHistory().environment,
    });
    placeElement(root, { left: 0, top: rootTop, width: 800, height: 600 });
    return { ...watchThePage(document, { root }), screens };
  }

  it('with scrollWhenTopHidden, a screen arriving while the root\'s top is above the window brings the root to the top', () => {
    const { scrolls, focuses, screens } = screensWithTopHidden(-300, true);
    screens.go('short');
    expect(scrolls).toEqual([['root', { block: 'start' }]]);
    expect(focuses).toEqual([{ preventScroll: false }]);
  });

  it('with scrollWhenTopHidden, a top under the host\'s sticky bar counts as hidden; one at or below the bar does not', () => {
    for (const [top, scrolled] of [
      [40, true],
      [56, false],
      [120, false],
    ] as const) {
      const { scrolls, screens } = screensWithTopHidden(top, true, '56px');
      screens.go('short');
      expect(scrolls.length > 0, `root at ${top}`).toBe(scrolled);
    }
  });

  it('without scrollWhenTopHidden, a root whose top is above the window but which is partly in view is not scrolled', () => {
    for (const option of [undefined, false]) {
      const { scrolls, screens } = screensWithTopHidden(-300, option);
      screens.go('short');
      expect(scrolls).toEqual([]);
    }
  });

  it('judges by, and scrolls to, the scroll target when the game names one', () => {
    const { document, hostElement: stage } = createFakePage();
    const root = document.createElement('div');
    stage.append(root);
    const screen = (id: string, address: string): ScreenDef => ({
      id,
      address,
      linkable: true,
      replacesPrevious: false,
      enter: () => ({ element: document.createElement('div') }),
    });
    const screens = createScreens({
      root,
      scrollTarget: stage,
      screens: [screen('menu', '/'), screen('list', '/list')],
      fallback: 'menu',
      onChange: () => {},
      environment: createFakeHistory().environment,
    });
    // The root is a layer with no box of its own; the stage it lies over is on screen.
    placeElement(root, { left: 0, top: 0, width: 0, height: 0 });
    placeElement(stage, { left: 0, top: 10, width: 800, height: 600 });
    const { scrolls } = watchThePage(document, { root, stage });
    screens.go('list');
    expect(scrolls).toEqual([]);

    placeElement(stage, { left: 0, top: -2000, width: 800, height: 600 });
    screens.go('menu');
    expect(scrolls).toEqual([['stage', { block: 'start' }]]);
  });

  it('the first screen, shown as the page loads, scrolls nothing wherever the root is', () => {
    const { document, hostElement: root } = createFakePage();
    const scrolls: unknown[] = [];
    root.scrollIntoView = () => {
      scrolls.push('root');
    };
    createScreens({
      root,
      screens: [{ id: 'menu', address: '/', linkable: true, replacesPrevious: false, enter: () => ({ element: document.createElement('div') }) }],
      fallback: 'menu',
      onChange: () => {},
      environment: createFakeHistory().environment,
    });
    expect(scrolls).toEqual([]);
  });
});

describe('screens and the address bar', () => {
  it('a load with no fragment, or with the home fragment, shows the home screen and writes no history', () => {
    for (const hash of ['', '#', '#/']) {
      const { shown, history } = setUp({ hash });
      expect(shown()).toBe('menu');
      expect(history.calls).toEqual([]);
    }
  });

  it('a load on a linkable address shows that screen, without moving focus', () => {
    const { document, shown, history } = setUp({ hash: '#/list' });
    expect(shown()).toBe('list');
    expect(history.calls).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });

  it('a load on an address that cannot be linked to, or that no screen has, is replaced by the fallback', () => {
    for (const hash of ['#/level', '#/summary', '#/nowhere']) {
      const { shown, history, screens } = setUp({ hash });
      expect(shown()).toBe('list');
      expect(screens.current()).toBe('list');
      expect(history.calls).toEqual([{ method: 'replaceState', state: null, url: '#/list' }]);
      expect(history.entries()).toEqual(['#/list']);
    }
  });

  it('going to a screen adds an entry with its fragment, and a screen that replaces the previous one adds none', () => {
    const { screens, history } = setUp();
    screens.go('list');
    expect(history.fragment()).toBe('#/list');
    screens.go('level', { number: 2 });
    expect(history.fragment()).toBe('#/level');
    screens.go('summary');
    expect(history.fragment()).toBe('#/summary');
    expect(history.entries()).toEqual(['', '#/list', '#/summary']);
    screens.go('menu');
    expect(history.entries()).toEqual(['', '#/list', '#/summary', '#/']);
    expect(history.calls.map((call) => call.method)).toEqual(['pushState', 'pushState', 'replaceState', 'pushState']);
  });

  it('passes null as the state of every entry it writes', () => {
    const { screens, history } = setUp({ hash: '#/level' });
    screens.go('level', { number: 1 });
    screens.go('summary');
    history.back();
    history.forward();
    expect(history.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of history.calls) {
      expect(call.state).toBeNull();
    }
  });

  it('Back and Forward show the screen at the address they land on and move focus to it', () => {
    const { document, root, screens, history, shown, log } = setUp();
    screens.go('list');
    screens.go('level', { number: 2 });
    history.back();
    expect(shown()).toBe('list');
    expect(screens.current()).toBe('list');
    expect(document.activeElement).toBe(root.querySelector('[data-role="last-chosen"]'));
    expect(log.at(-1)).toBe('level -> list');

    history.back();
    expect(shown()).toBe('menu');
    expect(history.fragment()).toBe('');
    history.forward();
    expect(shown()).toBe('list');
  });

  it('Back or Forward into a screen that cannot be linked to is replaced by the fallback', () => {
    const { screens, history, shown } = setUp();
    screens.go('list');
    screens.go('level', { number: 2 });
    history.back();
    history.forward();
    expect(shown()).toBe('list');
    expect(history.fragment()).toBe('#/list');
    expect(history.entries()).toEqual(['', '#/list', '#/list']);
    expect(history.calls.at(-1)).toEqual({ method: 'replaceState', state: null, url: '#/list' });
  });

  it('a link to a linkable fragment shows its screen', () => {
    const { history, shown } = setUp();
    history.followLink('#/list');
    expect(shown()).toBe('list');
    history.followLink('#/');
    expect(shown()).toBe('menu');
  });

  it('stops listening for Back and Forward on dispose', () => {
    const { root, screens, history } = setUp();
    screens.go('list');
    expect(history.listeners.added).toEqual(['popstate']);
    screens.dispose();
    expect(history.listeners.removed).toEqual(['popstate']);
    expect(history.listeners.listenerCount()).toBe(0);
    history.back();
    expect(root.children.length).toBe(0);
  });
});
