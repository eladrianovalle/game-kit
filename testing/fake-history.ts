// A stand-in for the part of a browser that screens are routed by: the URL
// fragment, the history list, and the `popstate` event that Back, Forward and a
// link to a fragment send. It remembers every `pushState` and `replaceState`
// call so a test can check what was written and with what state.

import { createRecordingTarget } from './recording-target';

export interface HistoryCall {
  method: 'pushState' | 'replaceState';
  state: unknown;
  url: string;
}

export function createFakeHistory(options: { hash?: string } = {}) {
  const listeners = createRecordingTarget();
  /** The fragment of each entry, oldest first. */
  let entries: string[] = [options.hash ?? ''];
  let position = 0;
  const calls: HistoryCall[] = [];

  /** Land on another entry, as the browser does: the URL changes first, then `popstate` is sent. */
  const travelTo = (nextPosition: number): void => {
    if (nextPosition < 0 || nextPosition >= entries.length) {
      return;
    }
    position = nextPosition;
    listeners.dispatch('popstate', { state: null });
  };

  const history = {
    pushState(state: unknown, _unused: string, url: string): void {
      calls.push({ method: 'pushState', state, url });
      // A new entry drops everything Forward could have reached.
      entries = [...entries.slice(0, position + 1), url];
      position += 1;
    },
    replaceState(state: unknown, _unused: string, url: string): void {
      calls.push({ method: 'replaceState', state, url });
      entries[position] = url;
    },
    back: () => travelTo(position - 1),
    forward: () => travelTo(position + 1),
  };

  const location = {
    get hash(): string {
      return entries[position];
    },
  };

  const environment = {
    history,
    location,
    addEventListener: listeners.addEventListener,
    removeEventListener: listeners.removeEventListener,
  } as unknown as Pick<Window, 'history' | 'location' | 'addEventListener' | 'removeEventListener'>;

  return {
    environment,
    listeners,
    /** Every `pushState` and `replaceState` so far, in order. */
    calls,
    /** The fragment the URL holds now. */
    fragment: (): string => entries[position],
    /** The fragment of every entry, oldest first. */
    entries: (): string[] => [...entries],
    back: history.back,
    forward: history.forward,
    /** The visitor follows a link to a fragment, or types one: a new entry, then `popstate`. */
    followLink(fragment: string): void {
      entries = [...entries.slice(0, position + 1), fragment];
      position += 1;
      listeners.dispatch('popstate', { state: null });
    },
  };
}
