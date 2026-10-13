// The state of a game's named actions: which are held, and which were pressed
// since the last step. Keys, touch controls and anything else feed it through
// `press` and `release`; the rules read it through `take`.

export interface ActionSnapshot<A extends string> {
  /** True while any source holds the action. */
  held: Readonly<Record<A, boolean>>;
  /** True for exactly one step after the action goes down. */
  pressed: Readonly<Record<A, boolean>>;
}

export interface Actions<A extends string> {
  /** A source starts holding an action. `source` is any unique string: a key code, 'touch:pad'. */
  press(action: A, source: string): void;
  release(action: A, source: string): void;
  releaseAll(): void;
  /** The input for one step. Clears the waiting presses, so call it once per step. */
  take(): ActionSnapshot<A>;
}

export function createActions<A extends string>(names: readonly A[]): Actions<A> {
  const holders = new Map<A, Set<string>>();
  const waitingPresses = new Set<A>();
  for (const name of names) {
    holders.set(name, new Set());
  }

  const holdersOf = (action: A): Set<string> => {
    const sources = holders.get(action);
    if (!sources) {
      throw new Error(`Unknown action "${action}"`);
    }
    return sources;
  };

  return {
    press(action, source) {
      const sources = holdersOf(action);
      // A press is the move from not held to held, so a second source joining
      // an action that is already down is not a new press.
      if (sources.size === 0) {
        waitingPresses.add(action);
      }
      sources.add(source);
    },
    release(action, source) {
      holdersOf(action).delete(source);
    },
    releaseAll() {
      for (const sources of holders.values()) {
        sources.clear();
      }
    },
    take() {
      const held = {} as Record<A, boolean>;
      const pressed = {} as Record<A, boolean>;
      for (const name of names) {
        held[name] = holdersOf(name).size > 0;
        pressed[name] = waitingPresses.has(name);
      }
      waitingPresses.clear();
      return { held, pressed };
    },
  };
}
