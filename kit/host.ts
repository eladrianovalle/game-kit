// The host contract: everything a page needs to know to run a game, and
// everything a game may assume about the page. Types only, no code.

export interface GameResult {
  outcome: 'won' | 'lost';
  score: number;
}

export interface MountOptions {
  /** Called every time a run ends and the results screen shows. May fire many times per mount. */
  onFinished?: (result: GameResult) => void;
}

export interface MountedGame {
  /** Resolves when the first screen is visible and usable. Rejects if the game cannot start. */
  ready: Promise<void>;
  /** Remove everything the game added. Works at any time, including before `ready`. Safe to call twice. */
  unmount(): void;
}

/** Returns at once. Loading continues in the background and is reported through `ready`. */
export type Mount = (element: HTMLElement, options?: MountOptions) => MountedGame;
