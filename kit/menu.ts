// Lets a pad work a screen made of page controls. It moves the browser's own
// focus from one control to the next and clicks the focused one, so the page
// shows focus and answers a click exactly as it does for the Tab and Enter keys.
// It puts nothing on the page and listens to nothing: the game calls it from the
// pressed actions it chooses, on the frames where it is not in play.

/** What counts as a control: buttons, links that go somewhere, inputs the player can reach, and selects. */
const CONTROL_SELECTOR = 'button, a[href], input:not([type="hidden"]), select';

/**
 * A control the browser would refuse to focus is skipped: a disabled one, or one inside a `hidden` or
 * `inert` element. One hidden by CSS is not caught here; `focusFrom` steps past it when focus does not move.
 */
function canTakeFocus(control: HTMLElement): boolean {
  return !control.matches(':disabled') && control.closest('[hidden], [inert]') === null;
}

/** Moves the browser's own focus through a screen's controls, for a pad. */
export function createMenuFocus(config: {
  /** Where focus is asked: the game's shadow root. */
  root: Pick<ShadowRoot, 'activeElement'>;
  /** The element whose controls are walked now: the current screen, or an open panel. */
  scope(): ParentNode | null;
}): { next(): void; previous(): void; activate(): void } {
  const { root, scope } = config;

  /** The controls of the current scope, in document order. Read fresh, because a screen changes. */
  const controlsNow = (): HTMLElement[] => {
    const scopeElement = scope();
    if (scopeElement === null) {
      return [];
    }
    return Array.from(scopeElement.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(canTakeFocus);
  };

  /** The place of the focused control in the list, or -1 when focus is somewhere else. */
  const focusedIndexIn = (controls: readonly HTMLElement[]): number => {
    const focused = root.activeElement;
    return controls.findIndex((control) => control === focused);
  };

  /**
   * Focuses the first control from `start` on, going by `direction` and wrapping, that takes focus. A
   * browser refuses focus to a control hidden by CSS without saying so, so each is tried and checked;
   * one that refuses is passed over, and if none takes it focus stays where it was.
   */
  const focusFrom = (controls: readonly HTMLElement[], start: number, direction: 1 | -1): void => {
    for (let tried = 0; tried < controls.length; tried += 1) {
      const control = controls[(start + direction * tried + controls.length * controls.length) % controls.length];
      control.focus();
      if (root.activeElement === control) {
        return;
      }
    }
  };

  return {
    next() {
      const controls = controlsNow();
      if (controls.length === 0) {
        return;
      }
      // With nothing focused the index is -1, so this starts at the first control.
      focusFrom(controls, focusedIndexIn(controls) + 1, 1);
    },
    previous() {
      const controls = controlsNow();
      if (controls.length === 0) {
        return;
      }
      const focusedIndex = focusedIndexIn(controls);
      focusFrom(controls, focusedIndex <= 0 ? controls.length - 1 : focusedIndex - 1, -1);
    },
    activate() {
      const controls = controlsNow();
      const focusedIndex = focusedIndexIn(controls);
      if (focusedIndex === -1) {
        return;
      }
      controls[focusedIndex].click();
    },
  };
}
