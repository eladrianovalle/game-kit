import { describe, expect, it } from 'vitest';
import { createActions } from './actions';
import { bindKeyboard } from './keyboard';

type Listener = (event: unknown) => void;

/** A stand-in for `window` that keeps its listeners in the open. */
function createFakeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  const target = {
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  return {
    target,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    /** Send a key event and report whether its default was stopped. */
    key(type: 'keydown' | 'keyup', code: string, extra: Partial<KeyboardEvent> = {}): boolean {
      let defaultPrevented = false;
      const event = {
        code,
        repeat: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: () => {
          defaultPrevented = true;
        },
        ...extra,
      };
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
      return defaultPrevented;
    },
    blur() {
      for (const listener of listeners.get('blur') ?? []) {
        listener({});
      }
    },
  };
}

function setUp(isCapturing: (action: 'left' | 'pause') => boolean = () => true) {
  const fake = createFakeTarget();
  const actions = createActions(['left', 'pause'] as const);
  const keyboard = bindKeyboard({
    actions,
    bindings: { ArrowLeft: 'left', KeyA: 'left', Space: 'pause' },
    isCapturing,
    target: fake.target,
  });
  return { fake, actions, keyboard };
}

describe('keyboard', () => {
  it('presses the bound action and stops the key scrolling the page', () => {
    const { fake, actions } = setUp();
    expect(fake.key('keydown', 'ArrowLeft')).toBe(true);
    const snapshot = actions.take();
    expect(snapshot.held.left).toBe(true);
    expect(snapshot.pressed.left).toBe(true);
  });

  it('leaves an unbound key to the page', () => {
    const { fake, actions } = setUp();
    expect(fake.key('keydown', 'Tab')).toBe(false);
    expect(actions.take().held).toEqual({ left: false, pause: false });
  });

  it('leaves a bound key to the page while the game is not capturing it', () => {
    const { fake, actions } = setUp(() => false);
    expect(fake.key('keydown', 'Space')).toBe(false);
    expect(actions.take().pressed.pause).toBe(false);
  });

  it('asks about each key by its action, so one action can be captured and another not', () => {
    const { fake, actions } = setUp((action) => action === 'pause');
    expect(fake.key('keydown', 'ArrowLeft')).toBe(false);
    expect(fake.key('keydown', 'Space')).toBe(true);
    const snapshot = actions.take();
    expect(snapshot.held.left).toBe(false);
    expect(snapshot.pressed.pause).toBe(true);
  });

  it.each(['ctrlKey', 'altKey', 'metaKey'] as const)('never takes a key pressed with %s', (modifier) => {
    const { fake, actions } = setUp();
    expect(fake.key('keydown', 'ArrowLeft', { [modifier]: true })).toBe(false);
    expect(actions.take().held.left).toBe(false);
  });

  it('does not press again on key repeat, but still stops the page scrolling', () => {
    const { fake, actions } = setUp();
    fake.key('keydown', 'Space');
    actions.take();
    expect(fake.key('keydown', 'Space', { repeat: true })).toBe(true);
    expect(actions.take().pressed.pause).toBe(false);
  });

  it('releases a key on key-up even when the game has stopped capturing', () => {
    let capturing = true;
    const { fake, actions } = setUp(() => capturing);
    fake.key('keydown', 'ArrowLeft');
    capturing = false;
    fake.key('keyup', 'ArrowLeft');
    expect(actions.take().held.left).toBe(false);
  });

  it('releases everything when the window loses focus', () => {
    const { fake, actions } = setUp();
    fake.key('keydown', 'ArrowLeft');
    fake.blur();
    expect(actions.take().held.left).toBe(false);
  });

  it('removes every listener it added on dispose', () => {
    const { fake, keyboard } = setUp();
    expect(fake.listenerCount()).toBe(3);
    keyboard.dispose();
    expect(fake.listenerCount()).toBe(0);
  });
});
