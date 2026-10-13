import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeGamepads } from '../testing/fake-gamepads';
import { createActions, type Actions } from './actions';
import type { PadBindings } from './bindings';
import { bindGamepad, stickDirection, STICK_PRESS, STICK_RELEASE, STICK_SWITCH, type GamepadEnvironment, type PadState } from './gamepad';
import type { PadDirection } from './touch';

const ACTION_NAMES = ['up', 'left', 'right', 'jump', 'pause'] as const;
type Action = (typeof ACTION_NAMES)[number];

const BINDINGS: PadBindings<Action> = {
  south: 'jump',
  start: 'pause',
  'dpad-up': 'up',
  'stick-up': 'up',
  'stick-left': 'left',
  'stick-right': 'right',
};

const NOTHING_HELD: Record<Action, boolean> = { up: false, left: false, right: false, jump: false, pause: false };

/** The real actions, with every press and release that reaches them written down in order. */
function createLoggedActions() {
  const real = createActions(ACTION_NAMES);
  const log: string[] = [];
  const actions: Actions<Action> = {
    press(action, source) {
      log.push(`press ${action} ${source}`);
      real.press(action, source);
    },
    release(action, source) {
      log.push(`release ${action} ${source}`);
      real.release(action, source);
    },
    releaseAll: () => real.releaseAll(),
    take: () => real.take(),
  };
  return { actions, log };
}

function setUp(isCapturing: (action: Action) => boolean = () => true) {
  const fake = createFakeGamepads();
  const { actions, log } = createLoggedActions();
  const pad = bindGamepad({ actions, bindings: BINDINGS, environment: fake.environment, isCapturing });
  return { fake, actions, log, pad };
}

describe('gamepad: a button is a press when it goes down, and held until it is let go', () => {
  it('gives pressed for one take and held until released', () => {
    const { fake, actions, pad } = setUp();
    const controller = fake.connect();
    controller.hold('south');

    pad.poll();
    const first = actions.take();
    expect(first.pressed.jump).toBe(true);
    expect(first.held.jump).toBe(true);

    pad.poll();
    const second = actions.take();
    expect(second.pressed.jump).toBe(false);
    expect(second.held.jump).toBe(true);

    controller.release('south');
    pad.poll();
    const third = actions.take();
    expect(third.pressed.jump).toBe(false);
    expect(third.held.jump).toBe(false);
  });

  it('names the pad input as the source of the press and of the release', () => {
    const { fake, log, pad } = setUp();
    const controller = fake.connect();
    controller.hold('south');
    pad.poll();
    controller.release('south');
    pad.poll();
    expect(log).toEqual(['press jump pad:south', 'release jump pad:south']);
  });

  it('gives one press for two polls before one take', () => {
    const { fake, actions, log, pad } = setUp();
    fake.connect().hold('south');
    pad.poll();
    pad.poll();
    expect(log).toEqual(['press jump pad:south']);
    expect(actions.take().pressed.jump).toBe(true);
    expect(actions.take().pressed.jump).toBe(false);
  });

  it('does not press a button still held after releaseAll until it is released and pressed', () => {
    const { fake, actions, pad } = setUp();
    const controller = fake.connect();
    controller.hold('south');
    pad.poll();
    actions.take();

    actions.releaseAll();
    pad.poll();
    const stillDown = actions.take();
    expect(stillDown.pressed.jump).toBe(false);
    expect(stillDown.held.jump).toBe(false);

    controller.release('south');
    pad.poll();
    controller.hold('south');
    pad.poll();
    const pressedAgain = actions.take();
    expect(pressedAgain.pressed.jump).toBe(true);
    expect(pressedAgain.held.jump).toBe(true);
  });

  it('presses once for a button already down when the pad is first seen', () => {
    const { fake, actions, log, pad } = setUp();
    pad.poll();
    expect(pad.status()).toBe('none');

    // A browser hides a pad until a button is pressed, so it arrives with that button down.
    fake.connect().hold('start');
    pad.poll();
    pad.poll();
    expect(log).toEqual(['press pause pad:start']);
    expect(actions.take().pressed.pause).toBe(true);
    expect(pad.status()).toBe('ready');
  });

  it('reads every bound button at its place in the standard mapping', () => {
    const places = [
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
    ] as const;
    for (const [input, index] of places) {
      const buttons = Array.from({ length: 17 }, (_, place) => ({ pressed: place === index }));
      const environment: GamepadEnvironment = {
        getGamepads: () => [{ connected: true, mapping: 'standard', buttons, axes: [0, 0, 0, 0] }],
      };
      const { actions, log } = createLoggedActions();
      const pad = bindGamepad({ actions, bindings: { [input]: 'jump' }, environment, isCapturing: () => true });
      pad.poll();
      expect(log).toEqual([`press jump pad:${input}`]);
    }
  });

  it('holds an action that two inputs give until both are let go', () => {
    const { fake, actions, pad } = setUp();
    const controller = fake.connect();
    controller.hold('dpad-up');
    controller.stick(0, -1);
    pad.poll();
    expect(actions.take().held.up).toBe(true);
    controller.release('dpad-up');
    pad.poll();
    expect(actions.take().held.up).toBe(true);
    controller.stick(0, 0);
    pad.poll();
    expect(actions.take().held.up).toBe(false);
  });

  it('ignores an input no action is bound to', () => {
    const { fake, actions, log, pad } = setUp();
    const controller = fake.connect();
    controller.hold('north');
    pad.poll();
    controller.release('north');
    pad.poll();
    expect(log).toEqual([]);
    expect(actions.take().held).toEqual(NOTHING_HELD);
  });
});

describe('gamepad: the pads are read fresh on every poll', () => {
  it('calls getGamepads once per poll', () => {
    const fake = createFakeGamepads();
    let reads = 0;
    const environment: GamepadEnvironment = {
      getGamepads() {
        reads += 1;
        return fake.environment.getGamepads();
      },
    };
    const pad = bindGamepad({ actions: createActions(ACTION_NAMES), bindings: BINDINGS, environment, isCapturing: () => true });
    fake.connect();
    pad.poll();
    pad.poll();
    pad.poll();
    expect(reads).toBe(3);
  });

  it('works with a browser that hands out one live object and changes it in place', () => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
    const live = { connected: true, mapping: 'standard', buttons, axes: [0, 0, 0, 0] };
    const { actions, log } = createLoggedActions();
    const pad = bindGamepad({ actions, bindings: BINDINGS, environment: { getGamepads: () => [live] }, isCapturing: () => true });
    pad.poll();
    buttons[0]!.pressed = true;
    pad.poll();
    pad.poll();
    buttons[0]!.pressed = false;
    pad.poll();
    expect(log).toEqual(['press jump pad:south', 'release jump pad:south']);
  });
});

describe('gamepad: one active pad, chosen by a button going down', () => {
  it('has no active pad until one of its buttons goes down', () => {
    const { fake, actions, log, pad } = setUp();
    const controller = fake.connect();
    pad.poll();
    expect(pad.status()).toBe('none');

    controller.stick(1, 0);
    pad.poll();
    expect(log).toEqual([]);
    expect(actions.take().held).toEqual(NOTHING_HELD);
    expect(pad.status()).toBe('none');

    // The button's own press counts, and from then on the stick is read too.
    controller.hold('south');
    pad.poll();
    expect(pad.status()).toBe('ready');
    const snapshot = actions.take();
    expect(snapshot.pressed.jump).toBe(true);
    expect(snapshot.held.right).toBe(true);
  });

  it('is made active by a button no action is bound to', () => {
    const { fake, actions, pad } = setUp();
    const controller = fake.connect();
    controller.hold('north');
    controller.stick(1, 0);
    pad.poll();
    expect(pad.status()).toBe('ready');
    expect(actions.take().held.right).toBe(true);
  });

  it('lets a button on the other pad take over, after the first pad holds are released', () => {
    const { fake, actions, log, pad } = setUp();
    const first = fake.connect();
    const second = fake.connect();
    first.hold('south');
    pad.poll();
    actions.take();
    log.length = 0;

    second.hold('start');
    pad.poll();
    expect(log).toEqual(['release jump pad:south', 'press pause pad:start']);
    const snapshot = actions.take();
    expect(snapshot.held.jump).toBe(false);
    expect(snapshot.pressed.pause).toBe(true);
    expect(pad.status()).toBe('ready');
  });

  it('does not hand the game back to the first pad for a button it was already holding', () => {
    const { fake, actions, log, pad } = setUp();
    const first = fake.connect();
    const second = fake.connect();
    first.hold('south');
    pad.poll();
    second.hold('start');
    pad.poll();
    actions.take();
    log.length = 0;

    // The first pad still has its button down. That is not a button going down.
    pad.poll();
    pad.poll();
    expect(log).toEqual([]);
    expect(actions.take().held).toEqual({ ...NOTHING_HELD, pause: true });

    first.release('south');
    pad.poll();
    first.hold('south');
    pad.poll();
    expect(log).toEqual(['release pause pad:start', 'press jump pad:south']);
  });

  it('feeds actions from the active pad only: a stick alone on the other pad does not take over', () => {
    const { fake, actions, log, pad } = setUp();
    const first = fake.connect();
    const second = fake.connect();
    first.hold('south');
    pad.poll();
    actions.take();
    log.length = 0;

    second.stick(-1, 0);
    pad.poll();
    pad.poll();
    expect(log).toEqual([]);
    const snapshot = actions.take();
    expect(snapshot.held.jump).toBe(true);
    expect(snapshot.held.left).toBe(false);
  });
});

describe('stickDirection', () => {
  it('uses the thresholds the spec names', () => {
    expect([STICK_PRESS, STICK_RELEASE, STICK_SWITCH]).toEqual([0.5, 0.3, 1.5]);
  });

  it('gives a direction once the stick reaches the press threshold', () => {
    expect(stickDirection(0.49, 0, null)).toBeNull();
    expect(stickDirection(0.5, 0, null)).toBe('right');
    expect(stickDirection(-0.5, 0, null)).toBe('left');
    // The y axis is negative upward.
    expect(stickDirection(0, 0.5, null)).toBe('down');
    expect(stickDirection(0, -0.5, null)).toBe('up');
  });

  it('takes the stronger axis, and the horizontal one on a tie', () => {
    expect(stickDirection(0.6, -0.9, null)).toBe('up');
    expect(stickDirection(0.9, -0.6, null)).toBe('right');
    expect(stickDirection(0.7, -0.7, null)).toBe('right');
    expect(stickDirection(-0.7, 0.7, null)).toBe('left');
  });

  it('keeps a held direction until its own axis is back at the release threshold', () => {
    expect(stickDirection(0.31, 0, 'right')).toBe('right');
    expect(stickDirection(0.3, 0, 'right')).toBeNull();
    expect(stickDirection(0, -0.31, 'up')).toBe('up');
    expect(stickDirection(0, -0.3, 'up')).toBeNull();
    expect(stickDirection(-0.31, 0, 'left')).toBe('left');
    expect(stickDirection(0, 0.31, 'down')).toBe('down');
  });

  it('measures release on the held axis alone, not on the distance from centre', () => {
    // Far from the centre, but only 0.2 of it is toward the right: 'right' is let go.
    expect(stickDirection(0.2, 0.45, 'right')).toBeNull();
  });

  it('gives right every time for a stick moved across the diagonal and back, starting from none', () => {
    let direction: PadDirection | null = null;
    const seen: (PadDirection | null)[] = [];
    for (const [x, y] of [[0.8, -0.7], [0.7, -0.8], [0.8, -0.7], [0.7, -0.8], [0.8, -0.7]] as const) {
      direction = stickDirection(x, y, direction);
      seen.push(direction);
    }
    expect(seen).toEqual(['right', 'right', 'right', 'right', 'right']);
  });

  it('switches when the other axis is clearly the stronger one', () => {
    expect(stickDirection(0.4, -0.9, 'right')).toBe('up');
    expect(stickDirection(0.4, 0.9, 'right')).toBe('down');
    expect(stickDirection(0.9, -0.4, 'up')).toBe('right');
    expect(stickDirection(-0.9, 0.4, 'down')).toBe('left');
  });

  it('does not switch to an axis that is stronger but has not reached the press threshold', () => {
    expect(stickDirection(0.31, -0.49, 'right')).toBe('right');
  });

  it('gives the opposite direction at once for a stick reversed on its own axis', () => {
    expect(stickDirection(-0.8, 0, 'right')).toBe('left');
    expect(stickDirection(0, 0.8, 'up')).toBe('down');
  });
});

describe('gamepad: the stick holds one stick input at a time', () => {
  /** A pad made active by a button nothing is bound to, so the log holds only what the stick does. */
  function setUpWithActiveStick() {
    const context = setUp();
    const controller = context.fake.connect();
    controller.hold('north');
    context.pad.poll();
    return { ...context, controller };
  }

  it('releases stick-right and presses stick-left in one poll when the stick is thrown across', () => {
    const { controller, actions, log, pad } = setUpWithActiveStick();
    controller.stick(0.8, 0);
    pad.poll();
    expect(log).toEqual(['press right pad:stick-right']);
    actions.take();
    log.length = 0;

    controller.stick(-0.8, 0);
    pad.poll();
    expect(log).toEqual(['release right pad:stick-right', 'press left pad:stick-left']);
    const snapshot = actions.take();
    expect(snapshot.held.right).toBe(false);
    expect(snapshot.held.left).toBe(true);
    expect(snapshot.pressed.left).toBe(true);
  });

  it('keeps the direction through the dead band and lets it go at the release threshold', () => {
    const { controller, actions, pad } = setUpWithActiveStick();
    controller.stick(0.6, 0);
    pad.poll();
    expect(actions.take().held.right).toBe(true);
    controller.stick(0.4, 0);
    pad.poll();
    expect(actions.take().held.right).toBe(true);
    controller.stick(0.3, 0);
    pad.poll();
    expect(actions.take().held.right).toBe(false);
    // Back in the dead band from rest: not far enough to press again.
    controller.stick(0.4, 0);
    pad.poll();
    expect(actions.take().held.right).toBe(false);
  });

  it('binds the d-pad separately from the stick', () => {
    const { fake, log, pad } = setUp();
    const controller = fake.connect();
    controller.hold('dpad-left');
    pad.poll();
    // 'dpad-left' is bound to nothing here, though 'stick-left' is.
    expect(log).toEqual([]);
    controller.stick(-1, 0);
    pad.poll();
    expect(log).toEqual(['press left pad:stick-left']);
  });
});

describe('gamepad: gated like a key', () => {
  it('does not press an action isCapturing refuses, and still releases it', () => {
    const asked: Action[] = [];
    const { fake, actions, log, pad } = setUp((action) => {
      asked.push(action);
      return action !== 'pause';
    });
    const controller = fake.connect();
    controller.hold('start');
    controller.hold('south');
    pad.poll();
    const snapshot = actions.take();
    expect(snapshot.pressed.pause).toBe(false);
    expect(snapshot.held.pause).toBe(false);
    expect(snapshot.pressed.jump).toBe(true);

    controller.release('start');
    pad.poll();
    expect(log).toEqual(['press jump pad:south', 'release pause pad:start']);
    // A press is asked; a release never is.
    expect(asked.sort()).toEqual(['jump', 'pause']);
  });

  it('releases a held action after capturing has turned off', () => {
    let capturing = true;
    const { fake, actions, pad } = setUp(() => capturing);
    const controller = fake.connect();
    controller.hold('south');
    pad.poll();
    expect(actions.take().held.jump).toBe(true);

    capturing = false;
    controller.release('south');
    pad.poll();
    expect(actions.take().held.jump).toBe(false);
  });

  it('does not press a button that went down while refused when capturing turns back on, and presses once it is released and pressed', () => {
    let capturing = false;
    const { fake, actions, log, pad } = setUp(() => capturing);
    const controller = fake.connect();
    controller.hold('south');
    pad.poll();
    expect(actions.take().pressed.jump).toBe(false);

    // A source that recorded only the presses it was allowed would press here.
    capturing = true;
    pad.poll();
    pad.poll();
    const stillDown = actions.take();
    expect(stillDown.pressed.jump).toBe(false);
    expect(stillDown.held.jump).toBe(false);
    expect(log).toEqual([]);

    controller.release('south');
    pad.poll();
    controller.hold('south');
    pad.poll();
    const pressedAgain = actions.take();
    expect(pressedAgain.pressed.jump).toBe(true);
    expect(pressedAgain.held.jump).toBe(true);
  });

  it('does not press a stick direction that was pushed while refused when capturing turns back on', () => {
    let capturing = true;
    const { fake, actions, pad } = setUp(() => capturing);
    const controller = fake.connect();
    controller.hold('north');
    pad.poll();

    capturing = false;
    controller.stick(1, 0);
    pad.poll();
    capturing = true;
    pad.poll();
    expect(actions.take().held.right).toBe(false);

    controller.stick(0, 0);
    pad.poll();
    controller.stick(1, 0);
    pad.poll();
    expect(actions.take().pressed.right).toBe(true);
  });
});

describe('gamepad: pads it cannot read', () => {
  it('reports none when there is no pad', () => {
    const { actions, log, pad } = setUp();
    expect(pad.status()).toBe('none');
    pad.poll();
    expect(pad.status()).toBe('none');
    expect(log).toEqual([]);
    expect(actions.take().held).toEqual(NOTHING_HELD);
  });

  it('gives no action for a non-standard pad and reports unsupported', () => {
    const { fake, actions, log, pad } = setUp();
    const controller = fake.connect({ mapping: '' });
    controller.hold('south');
    controller.hold('start');
    controller.stick(1, 0);
    pad.poll();
    pad.poll();
    expect(log).toEqual([]);
    const snapshot = actions.take();
    expect(snapshot.held).toEqual(NOTHING_HELD);
    expect(snapshot.pressed).toEqual(NOTHING_HELD);
    expect(pad.status()).toBe('unsupported');
  });

  it('reads the standard pad when a non-standard one is connected too', () => {
    const { fake, actions, pad } = setUp();
    fake.connect({ mapping: '' }).hold('start');
    const standard = fake.connect();
    pad.poll();
    // A standard pad is there but unused: nothing is unsupported, and nothing is read yet.
    expect(pad.status()).toBe('none');
    standard.hold('south');
    pad.poll();
    expect(pad.status()).toBe('ready');
    const snapshot = actions.take();
    expect(snapshot.pressed.jump).toBe(true);
    expect(snapshot.held.pause).toBe(false);
  });

  it('goes back to unsupported when the standard pad leaves and a non-standard one stays', () => {
    const { fake, pad } = setUp();
    fake.connect({ mapping: '' });
    const standard = fake.connect();
    standard.hold('south');
    pad.poll();
    standard.disconnect();
    pad.poll();
    expect(pad.status()).toBe('unsupported');
  });
});

describe('gamepad: nothing is left held', () => {
  it('releases the holds of a pad that disconnects mid-hold, and no pad is active', () => {
    const { fake, actions, pad } = setUp();
    const controller = fake.connect();
    controller.hold('south');
    controller.stick(1, 0);
    pad.poll();
    expect(actions.take().held).toEqual({ ...NOTHING_HELD, jump: true, right: true });

    controller.disconnect();
    pad.poll();
    expect(actions.take().held).toEqual(NOTHING_HELD);
    expect(pad.status()).toBe('none');
  });

  it('releases the holds of a pad whose connected turns false', () => {
    const state = { connected: true };
    const snapshot = (): PadState => ({
      connected: state.connected,
      mapping: 'standard',
      buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: index === 0 })),
      axes: [0, 0, 0, 0],
    });
    const actions = createActions(ACTION_NAMES);
    const pad = bindGamepad({ actions, bindings: BINDINGS, environment: { getGamepads: () => [snapshot()] }, isCapturing: () => true });
    pad.poll();
    expect(actions.take().held.jump).toBe(true);

    state.connected = false;
    pad.poll();
    expect(actions.take().held).toEqual(NOTHING_HELD);
    expect(pad.status()).toBe('none');
  });

  it('presses again for a button still down on a pad that comes back in the same place', () => {
    const southDown: PadState = {
      connected: true,
      mapping: 'standard',
      buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: index === 0 })),
      axes: [0, 0, 0, 0],
    };
    let pads: readonly (PadState | null)[] = [southDown];
    const actions = createActions(ACTION_NAMES);
    const pad = bindGamepad({ actions, bindings: BINDINGS, environment: { getGamepads: () => pads }, isCapturing: () => true });
    pad.poll();
    pads = [null];
    pad.poll();
    actions.take();

    // A browser shows a pad again when one of its buttons is pressed, so it comes back with that button down.
    pads = [southDown];
    pad.poll();
    expect(actions.take().pressed.jump).toBe(true);
    expect(pad.status()).toBe('ready');
  });

  it('releases the holds on dispose, and a later poll does nothing', () => {
    const { fake, actions, log, pad } = setUp();
    const controller = fake.connect();
    controller.hold('south');
    controller.stick(1, 0);
    pad.poll();
    actions.take();

    pad.dispose();
    expect(actions.take().held).toEqual(NOTHING_HELD);

    log.length = 0;
    controller.release('south');
    controller.hold('start');
    pad.poll();
    expect(log).toEqual([]);
    const snapshot = actions.take();
    expect(snapshot.held).toEqual(NOTHING_HELD);
    expect(snapshot.pressed).toEqual(NOTHING_HELD);
  });

  it('reads a throwing getGamepads as no pads, and releases what was held', () => {
    const { fake, actions, pad } = setUp();
    const controller = fake.connect();
    controller.hold('south');
    pad.poll();
    expect(actions.take().held.jump).toBe(true);

    fake.forbid();
    expect(() => pad.poll()).not.toThrow();
    expect(actions.take().held).toEqual(NOTHING_HELD);
    expect(pad.status()).toBe('none');
  });

  it('does nothing when getGamepads throws from the start', () => {
    const { fake, actions, pad } = setUp();
    fake.forbid();
    expect(() => pad.poll()).not.toThrow();
    expect(actions.take().held).toEqual(NOTHING_HELD);
    expect(pad.status()).toBe('none');
  });
});

describe('gamepad: nothing on the page', () => {
  it('has no listener and no timer in its source, not even in a comment', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gamepad.ts'), 'utf8');
    for (const word of ['addEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame']) {
      expect(source.includes(word), word).toBe(false);
    }
  });
});
