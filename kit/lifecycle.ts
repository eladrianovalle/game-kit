// One teardown list. Everything a game adds to the page registers its removal
// here at the moment it is added, and `dispose` undoes it all, newest first.
// Also: telling a game when its tab is hidden, so it can pause itself.

export interface Disposer {
  /**
   * Register a teardown. If the list has already been disposed the teardown runs
   * at once, so something that finishes loading after the game was removed is
   * cleaned up the moment it arrives.
   */
  add(teardown: () => void): void;
  /** Run every teardown, in reverse order of registration. A second call does nothing. */
  dispose(): void;
  isDisposed(): boolean;
}

export function createDisposer(): Disposer {
  const teardowns: Array<() => void> = [];
  let disposed = false;

  return {
    add(teardown) {
      if (disposed) {
        teardown();
        return;
      }
      teardowns.push(teardown);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // One failing teardown must not leave the rest of the page uncleaned, so
      // every teardown runs and the first failure is reported at the end.
      let firstError: unknown;
      let failed = false;
      while (teardowns.length > 0) {
        const teardown = teardowns.pop()!;
        try {
          teardown();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
      if (failed) {
        throw firstError;
      }
    },
    isDisposed() {
      return disposed;
    },
  };
}

/**
 * Tells a game whenever its tab is hidden or shown again. A game pauses when it
 * is hidden and stays paused when it is shown: only the player resumes.
 */
export function watchVisibility(config: {
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  onChange(visible: boolean): void;
}): Disposer {
  const { document, onChange } = config;
  const onVisibilityChange = (): void => onChange(document.visibilityState === 'visible');

  document.addEventListener('visibilitychange', onVisibilityChange);
  const disposer = createDisposer();
  disposer.add(() => document.removeEventListener('visibilitychange', onVisibilityChange));
  return disposer;
}
