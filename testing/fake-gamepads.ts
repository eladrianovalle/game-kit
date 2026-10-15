// Game controllers for tests. It behaves like the strictest browser: every read
// gives new, frozen snapshots, and a pad that was unplugged leaves a null in its
// place. A source that keeps the first pad object it was given fails here, as it
// would in Chrome.

import type { PadInput } from '../kit/bindings';
import type { GamepadEnvironment, PadState } from '../kit/gamepad';

/** A pad with the standard mapping has 17 buttons and 4 axes. */
const BUTTON_COUNT = 17;
const AXIS_COUNT = 4;

/** Where each button sits in the `buttons` list of a pad with the standard mapping. */
const BUTTON_INDEX: Readonly<Partial<Record<PadInput, number>>> = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  'left-bumper': 4,
  'right-bumper': 5,
  start: 9,
  'dpad-up': 12,
  'dpad-down': 13,
  'dpad-left': 14,
  'dpad-right': 15,
};

/** Where the left stick rests when it is pushed all the way. The y axis is negative upward. */
const STICK_POSITION: Readonly<Partial<Record<PadInput, readonly [number, number]>>> = {
  'stick-up': [0, -1],
  'stick-down': [0, 1],
  'stick-left': [-1, 0],
  'stick-right': [1, 0],
};

interface FakePad {
  mapping: string;
  buttonsDown: Set<number>;
  stickX: number;
  stickY: number;
}

export function createFakeGamepads() {
  /** One entry per pad ever connected, in order. An unplugged pad's entry becomes null. */
  const slots: (FakePad | null)[] = [];
  let forbidden = false;

  const snapshotOf = (pad: FakePad): PadState => {
    const buttons = Array.from({ length: BUTTON_COUNT }, (_, index) => Object.freeze({ pressed: pad.buttonsDown.has(index) }));
    const axes = Array.from({ length: AXIS_COUNT }, () => 0);
    axes[0] = pad.stickX;
    axes[1] = pad.stickY;
    return Object.freeze({
      connected: true,
      mapping: pad.mapping,
      buttons: Object.freeze(buttons),
      axes: Object.freeze(axes),
    });
  };

  const environment: GamepadEnvironment = {
    getGamepads() {
      if (forbidden) {
        throw new Error('The fake forbids reading the gamepads.');
      }
      return Object.freeze(slots.map((pad) => (pad === null ? null : snapshotOf(pad))));
    },
  };

  return {
    environment,
    /** A pad appears. `mapping` defaults to 'standard'. */
    connect(options: { mapping?: string } = {}) {
      const pad: FakePad = { mapping: options.mapping ?? 'standard', buttonsDown: new Set(), stickX: 0, stickY: 0 };
      const slot = slots.length;
      slots.push(pad);

      const setStick = (x: number, y: number): void => {
        pad.stickX = x;
        pad.stickY = y;
      };

      return {
        /** Push a button down, or the stick all the way in a direction. */
        hold(input: PadInput): void {
          const index = BUTTON_INDEX[input];
          if (index !== undefined) {
            pad.buttonsDown.add(index);
            return;
          }
          const position = STICK_POSITION[input];
          if (position !== undefined) {
            setStick(position[0], position[1]);
          }
        },
        /**
         * Let a button go, or let the stick back to its centre. A stick input centres the stick
         * only while the stick is pushed that way: releasing one it is not pushed toward does nothing.
         */
        release(input: PadInput): void {
          const index = BUTTON_INDEX[input];
          if (index !== undefined) {
            pad.buttonsDown.delete(index);
            return;
          }
          const position = STICK_POSITION[input];
          if (position !== undefined && pad.stickX * position[0] + pad.stickY * position[1] > 0) {
            setStick(0, 0);
          }
        },
        /** Put the left stick somewhere. Each value runs from -1 to 1, and y is negative upward. */
        stick: setStick,
        /** The pad is unplugged: its place in the list holds null from now on. */
        disconnect(): void {
          slots[slot] = null;
        },
      };
    },
    /** Make `getGamepads` throw, as a browser that forbids it does. */
    forbid(): void {
      forbidden = true;
    },
  };
}

export type FakeGamepads = ReturnType<typeof createFakeGamepads>;
