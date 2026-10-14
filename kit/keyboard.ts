// Maps keys to actions, and stops those keys doing their usual page job (an
// arrow key scrolling, Space paging down) while the game has them.

import type { Actions } from './actions';
import { createDisposer, type Disposer } from './lifecycle';

/** `KeyboardEvent.code` to action. */
export type KeyBindings<A extends string> = Readonly<Record<string, A>>;

export function bindKeyboard<A extends string>(config: {
  actions: Actions<A>;
  bindings: KeyBindings<A>;
  /**
   * Asked on every event for a bound key, with that key's action. The key is
   * taken, and its default stopped, only while this is true.
   */
  isCapturing(action: A): boolean;
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}): Disposer {
  const { actions, bindings, isCapturing, target } = config;

  const actionFor = (code: string): A | undefined =>
    Object.prototype.hasOwnProperty.call(bindings, code) ? bindings[code] : undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    // A key with Ctrl, Alt or Meta held is a browser or system shortcut, never the game's.
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const action = actionFor(event.code);
    if (action === undefined || !isCapturing(action)) {
      return;
    }
    event.preventDefault();
    // A key held down repeats; only the first event is a press.
    if (!event.repeat) {
      actions.press(action, event.code);
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    const action = actionFor(event.code);
    if (action === undefined) {
      return;
    }
    // Released whatever `isCapturing` says: a key let go while the game is not
    // listening must not still be held when it listens again.
    actions.release(action, event.code);
  };

  // A window that loses focus never sees the key-up, so everything is let go.
  const onBlur = (): void => {
    actions.releaseAll();
  };

  const disposer = createDisposer();
  const listen = <K extends 'keydown' | 'keyup' | 'blur'>(type: K, listener: (event: WindowEventMap[K]) => void): void => {
    target.addEventListener(type, listener);
    disposer.add(() => target.removeEventListener(type, listener));
  };
  listen('keydown', onKeyDown);
  listen('keyup', onKeyUp);
  listen('blur', onBlur);
  return disposer;
}
