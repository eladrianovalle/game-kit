// Lets a pad work a screen made of page controls. It moves the browser's own
// focus from one control to the next and clicks the focused one, so the page
// shows focus and answers a click exactly as it does for the Tab and Enter keys.
// It puts nothing on the page and listens to nothing: the game calls it from the
// pressed actions it chooses, on the frames where it is not in play.

/** What counts as a control: buttons, links that go somewhere, inputs the player can reach, and selects. */
const CONTROL_SELECTOR = 'button, a[href], input:not([type="hidden"]), select';

/** A control the browser would refuse to focus is skipped: a disabled one, or one inside a `hidden` element. */
function canTakeFocus(control: HTMLElement): boolean {
  return !control.matches(':disabled') && control.closest('[hidden]') === null;
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

  return {
    next() {
      const controls = controlsNow();
      if (controls.length === 0) {
        return;
      }
      // With nothing focused the index is -1, so this lands on the first control.
      const nextIndex = (focusedIndexIn(controls) + 1) % controls.length;
      controls[nextIndex].focus();
    },
    previous() {
      const controls = controlsNow();
      if (controls.length === 0) {
        return;
      }
      const focusedIndex = focusedIndexIn(controls);
      const previousIndex = focusedIndex <= 0 ? controls.length - 1 : focusedIndex - 1;
      controls[previousIndex].focus();
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
