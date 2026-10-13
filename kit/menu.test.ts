import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeGamepads } from '../testing/fake-gamepads';
import { createFakePage } from '../testing/fake-page';
import { createActions } from './actions';
import type { PadBindings } from './bindings';
import { bindGamepad } from './gamepad';
import { createMenuFocus } from './menu';

/**
 * A game's page as both games build it: a shadow root on the host element, with
 * one screen inside. Every click on a button of the screen is written down.
 */
function setUp() {
  const { document, hostElement } = createFakePage();
  const root = hostElement.attachShadow({ mode: 'open' });
  const screen = document.createElement('div');
  root.append(screen);
  const clicks: string[] = [];

  const addButton = (name: string, parent: ParentNode = screen): HTMLButtonElement => {
    const button = document.createElement('button');
    button.textContent = name;
    button.addEventListener('click', () => clicks.push(name));
    parent.append(button);
    return button;
  };

  return { document, hostElement, root, screen, clicks, addButton };
}

/** A screen with three buttons, and a menu focus that walks it. */
function setUpThreeButtons() {
  const page = setUp();
  const first = page.addButton('New Game');
  const second = page.addButton('Continue');
  const third = page.addButton('Controls');
  const menu = createMenuFocus({ root: page.root, scope: () => page.screen });
  return { ...page, first, second, third, menu };
}

describe('menu focus: the buttons are in a shadow root, and focus is asked of that root', () => {
  it('reads the focused button from the shadow root, where the document only names the host', () => {
    const { document, hostElement, root, first, second, menu } = setUpThreeButtons();

    menu.next();
    expect(root.activeElement).toBe(first);
    expect(document.activeElement).toBe(hostElement);

    // Moving on from the first button is only possible by asking the root: the document cannot tell the buttons apart.
    menu.next();
    expect(root.activeElement).toBe(second);
    expect(document.activeElement).toBe(hostElement);
  });
});

describe('menu focus: next and previous walk the controls in document order and wrap', () => {
  it('next focuses three buttons in order and wraps to the first', () => {
    const { root, first, second, third, menu } = setUpThreeButtons();

    menu.next();
    expect(root.activeElement).toBe(first);
    menu.next();
    expect(root.activeElement).toBe(second);
    menu.next();
    expect(root.activeElement).toBe(third);
    menu.next();
    expect(root.activeElement).toBe(first);
  });

  it('previous goes the other way and wraps to the last', () => {
    const { root, first, second, third, menu } = setUpThreeButtons();
    third.focus();

    menu.previous();
    expect(root.activeElement).toBe(second);
    menu.previous();
    expect(root.activeElement).toBe(first);
    menu.previous();
    expect(root.activeElement).toBe(third);
  });

  it('with nothing focused, next focuses the first and previous focuses the last', () => {
    const forNext = setUpThreeButtons();
    expect(forNext.root.activeElement).toBe(null);
    forNext.menu.next();
    expect(forNext.root.activeElement).toBe(forNext.first);

    const forPrevious = setUpThreeButtons();
    forPrevious.menu.previous();
    expect(forPrevious.root.activeElement).toBe(forPrevious.third);
  });

  it('with focus on a button outside the scope, next focuses the first and previous the last', () => {
    const { root, addButton, first, third, menu } = setUpThreeButtons();
    const outside = addButton('Outside', root);

    outside.focus();
    menu.next();
    expect(root.activeElement).toBe(first);

    outside.focus();
    menu.previous();
    expect(root.activeElement).toBe(third);
  });

  it('walks links, inputs and selects as well as buttons, and passes over other elements', () => {
    const { document, root, screen, addButton } = setUp();
    const button = addButton('Back');
    const paragraph = document.createElement('p');
    const link = document.createElement('a');
    link.href = '#/credits';
    const input = document.createElement('input');
    const select = document.createElement('select');
    screen.append(paragraph, link, input, select);
    const menu = createMenuFocus({ root, scope: () => screen });

    const visited: (Element | null)[] = [];
    for (let presses = 0; presses < 5; presses += 1) {
      menu.next();
      visited.push(root.activeElement);
    }
    expect(visited).toEqual([button, link, input, select, button]);
  });

  it('reads the scope on every call, so an open panel takes over from the screen', () => {
    const { document, root, screen, addButton, first } = setUpThreeButtons();
    const panel = document.createElement('div');
    screen.append(panel);
    const close = addButton('Close', panel);
    let scopeNow: ParentNode = screen;
    const menu = createMenuFocus({ root, scope: () => scopeNow });

    menu.next();
    expect(root.activeElement).toBe(first);

    scopeNow = panel;
    menu.next();
    expect(root.activeElement).toBe(close);
    menu.next();
    expect(root.activeElement).toBe(close);
  });

  it('does nothing when the scope is null or has no control', () => {
    const { root, first } = setUpThreeButtons();
    first.focus();

    const withoutScope = createMenuFocus({ root, scope: () => null });
    withoutScope.next();
    withoutScope.previous();
    expect(root.activeElement).toBe(first);

    const emptyPage = setUp();
    const withoutControls = createMenuFocus({ root: emptyPage.root, scope: () => emptyPage.screen });
    withoutControls.next();
    withoutControls.previous();
    expect(emptyPage.root.activeElement).toBe(null);
  });
});

describe('menu focus: a control the player cannot use is skipped', () => {
  it('skips a disabled button, forward and backward', () => {
    const { root, first, second, third, menu } = setUpThreeButtons();
    second.disabled = true;

    menu.next();
    expect(root.activeElement).toBe(first);
    menu.next();
    expect(root.activeElement).toBe(third);
    menu.previous();
    expect(root.activeElement).toBe(first);
  });

  it('skips a button under a hidden element, forward and backward', () => {
    const { document, root, screen, addButton, first, third, menu } = setUpThreeButtons();
    const hiddenPanel = document.createElement('div');
    hiddenPanel.hidden = true;
    const wrapper = document.createElement('div');
    hiddenPanel.append(wrapper);
    screen.append(hiddenPanel);
    addButton('Under hidden', wrapper);
    const last = addButton('Quit');

    third.focus();
    menu.next();
    expect(root.activeElement).toBe(last);
    menu.next();
    expect(root.activeElement).toBe(first);
    menu.previous();
    expect(root.activeElement).toBe(last);
    menu.previous();
    expect(root.activeElement).toBe(third);
  });

  it('skips a button that is itself hidden', () => {
    const { root, first, second, third, menu } = setUpThreeButtons();
    second.hidden = true;

    first.focus();
    menu.next();
    expect(root.activeElement).toBe(third);
  });
});

describe('menu focus: activate clicks the focused control', () => {
  it('clicks the focused button once, and only that one', () => {
    const { clicks, menu } = setUpThreeButtons();

    menu.next();
    menu.next();
    menu.activate();
    expect(clicks).toEqual(['Continue']);
  });

  it('does nothing when nothing is focused', () => {
    const { clicks, menu } = setUpThreeButtons();

    menu.activate();
    expect(clicks).toEqual([]);
  });

  it('does nothing when focus is outside the scope', () => {
    const { root, clicks, addButton, menu } = setUpThreeButtons();
    const outside = addButton('Outside', root);
    outside.focus();

    menu.activate();
    expect(clicks).toEqual([]);
  });

  it('does nothing when the scope is null, even with a button focused', () => {
    const { root, clicks, first } = setUpThreeButtons();
    const menu = createMenuFocus({ root, scope: () => null });
    first.focus();

    menu.activate();
    expect(clicks).toEqual([]);
  });
});

describe('menu focus: a pad works a menu screen, and is gated like a key in play', () => {
  const ACTION_NAMES = ['up', 'down', 'confirm', 'advance'] as const;
  type Action = (typeof ACTION_NAMES)[number];
  type ScreenId = 'title' | 'play';

  const PAD_BINDINGS: PadBindings<Action> = {
    'dpad-up': 'up',
    'dpad-down': 'down',
    south: 'confirm',
    east: 'advance',
  };
  const MENU_ACTIONS: ReadonlySet<Action> = new Set(['up', 'down', 'confirm']);

  /** A toy game: a Title screen of page buttons and a Play screen, with one frame that reads the pad as a game's does. */
  function setUpToyGame() {
    const page = setUpThreeButtons();
    const fake = createFakeGamepads();
    const actions = createActions(ACTION_NAMES);
    let currentScreen: ScreenId = 'title';
    let paused = false;

    // The keyboard's gate: every action is refused off the Play screen, and `advance` is refused while paused.
    const isCapturing = (action: Action): boolean => currentScreen === 'play' && !(paused && action === 'advance');

    const pad = bindGamepad({
      actions,
      bindings: PAD_BINDINGS,
      environment: fake.environment,
      // In play, exactly the keyboard's gate; elsewhere, also the menu actions and nothing else.
      isCapturing: (action) => isCapturing(action) || (currentScreen !== 'play' && MENU_ACTIONS.has(action)),
    });

    /** One frame: poll the pad, take the actions, and off the Play screen hand the menu presses to the menu focus. */
    const frame = () => {
      pad.poll();
      const { pressed } = actions.take();
      if (currentScreen !== 'play') {
        if (pressed.down) {
          page.menu.next();
        }
        if (pressed.up) {
          page.menu.previous();
        }
        if (pressed.confirm) {
          page.menu.activate();
        }
      }
      return pressed;
    };

    return {
      ...page,
      controller: fake.connect(),
      frame,
      isCapturing,
      goTo(screenId: ScreenId): void {
        currentScreen = screenId;
        // A game lets go of everything on a screen change.
        actions.releaseAll();
      },
      setPaused(value: boolean): void {
        paused = value;
      },
    };
  }

  it('on a menu screen, d-pad down moves focus and the bottom button clicks the focused button', () => {
    const { root, clicks, controller, frame, isCapturing, first, second } = setUpToyGame();
    // The keyboard's gate lets none of these through here: only the pad's own does.
    expect([isCapturing('down'), isCapturing('up'), isCapturing('confirm')]).toEqual([false, false, false]);

    controller.hold('dpad-down');
    frame();
    expect(root.activeElement).toBe(first);
    // Still held on the next frame: a hold is one press, so focus stays.
    frame();
    expect(root.activeElement).toBe(first);
    controller.release('dpad-down');
    frame();

    controller.hold('dpad-down');
    frame();
    controller.release('dpad-down');
    expect(root.activeElement).toBe(second);

    controller.hold('dpad-up');
    frame();
    controller.release('dpad-up');
    expect(root.activeElement).toBe(first);

    controller.hold('south');
    frame();
    expect(clicks).toEqual(['New Game']);
    frame();
    expect(clicks).toEqual(['New Game']);
  });

  it('on a menu screen, an action that is not a menu action is still refused', () => {
    const { controller, frame } = setUpToyGame();

    controller.hold('east');
    expect(frame().advance).toBe(false);
  });

  it('on the Play screen, an action the keyboard gate refuses is not pressed by the pad either', () => {
    const { controller, frame, isCapturing, goTo, setPaused } = setUpToyGame();
    goTo('play');
    setPaused(true);
    expect(isCapturing('advance')).toBe(false);

    controller.hold('east');
    expect(frame().advance).toBe(false);
    controller.release('east');
    frame();

    // Not paused, the keyboard's gate lets it through, and so does the pad's.
    setPaused(false);
    controller.hold('east');
    expect(frame().advance).toBe(true);
  });

  it('on the Play screen, a menu action reaches the game as an action and does not touch the page', () => {
    const { root, clicks, controller, frame, goTo, first } = setUpToyGame();
    first.focus();
    goTo('play');

    controller.hold('dpad-down');
    controller.hold('south');
    const pressed = frame();
    expect(pressed.down).toBe(true);
    expect(pressed.confirm).toBe(true);
    expect(root.activeElement).toBe(first);
    expect(clicks).toEqual([]);
  });

  it('a menu button still held when the screen changes to Play does not press there', () => {
    const { clicks, controller, frame, goTo } = setUpToyGame();
    controller.hold('dpad-down');
    frame();
    controller.hold('south');
    frame();
    expect(clicks).toEqual(['New Game']);

    goTo('play');
    const pressed = frame();
    expect(pressed.confirm).toBe(false);
    expect(pressed.down).toBe(false);
  });
});

describe('menu focus: nothing on the page', () => {
  it('leaves the page as it found it', () => {
    const { root, menu } = setUpThreeButtons();
    const before = root.innerHTML;

    menu.next();
    menu.previous();
    menu.activate();
    expect(root.innerHTML).toBe(before);
  });

  it('has no listener and no new element in its source, not even in a comment', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'menu.ts'), 'utf8');
    for (const word of ['addEventListener', 'createElement', 'append', 'insert', 'innerHTML', 'cloneNode']) {
      expect(source.includes(word), word).toBe(false);
    }
  });
});
