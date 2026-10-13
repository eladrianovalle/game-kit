// Lets a game controller press and release a game's actions. It adds nothing to
// the page: the game calls `poll` just before it reads its actions, and `poll`
// compares the pad with what it saw last time and presses or releases what changed.

import type { Actions } from './actions';
import type { PadBindings, PadInput } from './bindings';
import type { PadDirection } from './touch';

/** What is read of a browser's `Gamepad`. */
export interface PadState {
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

export interface GamepadEnvironment {
  getGamepads(): readonly (PadState | null)[];
}

/** How far the stick must go to mean a direction. */
export const STICK_PRESS = 0.5;
/** How far back the stick must come before it means none. */
export const STICK_RELEASE = 0.3;
/** How much stronger the other axis must be to change direction. */
export const STICK_SWITCH = 1.5;

/** The only layout that is read: the one where a button's place in the list says where it sits on the pad. */
const STANDARD_MAPPING = 'standard';

/** Where each button is in the `buttons` list of a pad with the standard mapping. */
const BUTTON_INDEXES = [
  ['south', 0],
  ['east', 1],
  ['west', 2],
  ['north', 3],
  ['left-bumper', 4],
  ['right-bumper', 5],
  ['start', 9],
  ['dpad-up', 12],
  ['dpad-down', 13],
  ['dpad-left', 14],
  ['dpad-right', 15],
] as const satisfies readonly (readonly [PadInput, number])[];

/** The left stick's place in the `axes` list. The y axis is negative upward, as the browser gives it. */
const STICK_X_AXIS = 0;
const STICK_Y_AXIS = 1;

const STICK_INPUTS: Readonly<Record<PadDirection, PadInput>> = {
  up: 'stick-up',
  down: 'stick-down',
  left: 'stick-left',
  right: 'stick-right',
};

/** The stick's direction when none is held: the stronger axis, once it has gone far enough. */
function directionFromRest(x: number, y: number): PadDirection | null {
  const horizontal = Math.abs(x);
  const vertical = Math.abs(y);
  // On a tie the horizontal axis wins, as it does in `padDirection`.
  if (horizontal >= vertical) {
    if (horizontal < STICK_PRESS) {
      return null;
    }
    return x > 0 ? 'right' : 'left';
  }
  if (vertical < STICK_PRESS) {
    return null;
  }
  return y > 0 ? 'down' : 'up';
}

/** The stick's direction, given the one it had. Pure. One of four, as `padDirection` gives. */
export function stickDirection(x: number, y: number, previous: PadDirection | null): PadDirection | null {
  if (previous === null) {
    return directionFromRest(x, y);
  }

  const heldIsHorizontal = previous === 'left' || previous === 'right';
  // How far the stick is pushed toward the held direction; negative when it is pushed the other way.
  let towardHeld: number;
  if (previous === 'right') {
    towardHeld = x;
  } else if (previous === 'left') {
    towardHeld = -x;
  } else if (previous === 'down') {
    towardHeld = y;
  } else {
    towardHeld = -y;
  }

  // Release is measured on the held axis alone, not on the stick's distance from centre.
  if (towardHeld > STICK_RELEASE) {
    const otherAxis = heldIsHorizontal ? y : x;
    const otherStrength = Math.abs(otherAxis);
    // A stick resting near a diagonal keeps its direction: the other axis must clearly win to take over.
    if (otherStrength >= STICK_PRESS && otherStrength >= STICK_SWITCH * towardHeld) {
      if (heldIsHorizontal) {
        return otherAxis > 0 ? 'down' : 'up';
      }
      return otherAxis > 0 ? 'right' : 'left';
    }
    return previous;
  }

  // The held direction is let go, so the stick is read again as if none were
  // held. A stick thrown straight to the opposite side gives the new direction at once.
  return directionFromRest(x, y);
}

export interface BoundGamepad {
  /** Read the pads and press or release what changed. Call just before every `actions.take()`. */
  poll(): void;
  /** 'none': no pad has been used. 'ready': one is being read. 'unsupported': pads are connected and none has the standard mapping. */
  status(): 'none' | 'ready' | 'unsupported';
  /** Lets go of everything the pad holds. A later `poll` does nothing. */
  dispose(): void;
}

export function bindGamepad<A extends string>(config: {
  actions: Actions<A>;
  bindings: PadBindings<A>;
  environment: GamepadEnvironment;
  /**
   * May this action be pressed now? A press is asked; a release never is. In
   * play it must refuse every action the keyboard's refuses, so a pad cannot
   * press an action there that the same key cannot.
   */
  isCapturing(action: A): boolean;
}): BoundGamepad {
  const { actions, bindings, environment, isCapturing } = config;

  /** The place in the browser's list of the pad that feeds the actions, or null when none does. */
  let activeSlot: number | null = null;
  /** The active pad's inputs that were down at the last poll, whether or not their press was allowed. */
  const inputsDown = new Set<PadInput>();
  let heldStickDirection: PadDirection | null = null;
  /**
   * For every standard pad, by its place in the list, the buttons that were
   * down at the last poll. Only the numbers are kept, never the pad object: a
   * browser may hand out a new snapshot on every read, and a kept one never changes.
   */
  const buttonsDownBySlot = new Map<number, Set<number>>();
  let currentStatus: 'none' | 'ready' | 'unsupported' = 'none';
  let disposed = false;

  const releaseHolds = (): void => {
    for (const input of inputsDown) {
      const action = bindings[input];
      if (action !== undefined) {
        actions.release(action, `pad:${input}`);
      }
    }
    inputsDown.clear();
    heldStickDirection = null;
  };

  const readPads = (): readonly (PadState | null)[] => {
    try {
      return environment.getGamepads();
    } catch {
      // A browser that forbids the pads throws here. That is read as no pads.
      return [];
    }
  };

  const isStandard = (pad: PadState | null | undefined): pad is PadState =>
    pad !== null && pad !== undefined && pad.connected && pad.mapping === STANDARD_MAPPING;

  /**
   * Notes which buttons each standard pad has down, and returns the first pad
   * other than the active one on which a button went down since the last poll.
   * A button already down on a pad seen for the first time counts as going down.
   */
  const findPadTakingOver = (pads: readonly (PadState | null)[]): number | null => {
    let takingOver: number | null = null;
    // Kept only for the pads that are here now, so a pad that left and comes
    // back in the same place is seen for the first time again.
    const downAtLastPoll = new Map(buttonsDownBySlot);
    buttonsDownBySlot.clear();
    pads.forEach((pad, slot) => {
      if (!isStandard(pad)) {
        return;
      }
      const downBefore = downAtLastPoll.get(slot) ?? new Set<number>();
      const downNow = new Set<number>();
      let aButtonWentDown = false;
      pad.buttons.forEach((button, index) => {
        if (button.pressed) {
          downNow.add(index);
          if (!downBefore.has(index)) {
            aButtonWentDown = true;
          }
        }
      });
      buttonsDownBySlot.set(slot, downNow);
      if (aButtonWentDown && slot !== activeSlot && takingOver === null) {
        takingOver = slot;
      }
    });
    return takingOver;
  };

  const inputsDownOn = (pad: PadState): Set<PadInput> => {
    const down = new Set<PadInput>();
    for (const [input, index] of BUTTON_INDEXES) {
      if (pad.buttons[index]?.pressed === true) {
        down.add(input);
      }
    }
    heldStickDirection = stickDirection(pad.axes[STICK_X_AXIS] ?? 0, pad.axes[STICK_Y_AXIS] ?? 0, heldStickDirection);
    if (heldStickDirection !== null) {
      down.add(STICK_INPUTS[heldStickDirection]);
    }
    return down;
  };

  return {
    poll() {
      if (disposed) {
        return;
      }
      const pads = readPads();

      // An active pad that is gone, or no longer connected, lets go of everything.
      if (activeSlot !== null && !isStandard(pads[activeSlot])) {
        releaseHolds();
        activeSlot = null;
      }

      // A pad becomes the active one by a button going down, never by its stick
      // alone, so a pad with a drifting stick does nothing.
      const takingOver = findPadTakingOver(pads);
      if (takingOver !== null) {
        releaseHolds();
        activeSlot = takingOver;
      }

      if (activeSlot === null) {
        const aPadIsConnected = pads.some((pad) => pad !== null && pad !== undefined && pad.connected);
        const aPadIsStandard = pads.some(isStandard);
        currentStatus = aPadIsConnected && !aPadIsStandard ? 'unsupported' : 'none';
        return;
      }
      currentStatus = 'ready';

      const downNow = inputsDownOn(pads[activeSlot]!);

      // Releases come first, so a stick thrown from one side to the other lets
      // go of the old direction before it presses the new one.
      for (const input of [...inputsDown]) {
        if (downNow.has(input)) {
          continue;
        }
        inputsDown.delete(input);
        const action = bindings[input];
        if (action !== undefined) {
          // Released whatever `isCapturing` says, as a key is.
          actions.release(action, `pad:${input}`);
        }
      }
      for (const input of downNow) {
        if (inputsDown.has(input)) {
          continue;
        }
        // Noted as down even when the press is refused. A button held while the
        // game starts capturing again must not press: it has to be let go and
        // pressed, as a held key does.
        inputsDown.add(input);
        const action = bindings[input];
        if (action !== undefined && isCapturing(action)) {
          actions.press(action, `pad:${input}`);
        }
      }
    },
    status: () => currentStatus,
    dispose() {
      releaseHolds();
      activeSlot = null;
      currentStatus = 'none';
      disposed = true;
    },
  };
}
