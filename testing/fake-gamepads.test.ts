import { describe, expect, it } from 'vitest';
import { createFakeGamepads } from './fake-gamepads';

describe('fake gamepads', () => {
  it('has no pads until one is connected', () => {
    const fake = createFakeGamepads();
    expect(fake.environment.getGamepads()).toEqual([]);
  });

  it('gives a connected pad the standard mapping unless told otherwise', () => {
    const fake = createFakeGamepads();
    fake.connect();
    fake.connect({ mapping: '' });
    const pads = fake.environment.getGamepads();
    expect(pads.map((pad) => pad?.mapping)).toEqual(['standard', '']);
    expect(pads.map((pad) => pad?.connected)).toEqual([true, true]);
  });

  it('returns new snapshot objects on every call', () => {
    const fake = createFakeGamepads();
    fake.connect();
    const first = fake.environment.getGamepads();
    const second = fake.environment.getGamepads();
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.buttons).not.toBe(first[0]!.buttons);
    expect(second[0]!.buttons[0]).not.toBe(first[0]!.buttons[0]);
    expect(second[0]!.axes).not.toBe(first[0]!.axes);
    expect(second).toEqual(first);
  });

  it('freezes every snapshot, all the way down', () => {
    const fake = createFakeGamepads();
    fake.connect();
    const pads = fake.environment.getGamepads();
    const pad = pads[0]!;
    expect(Object.isFrozen(pads)).toBe(true);
    expect(Object.isFrozen(pad)).toBe(true);
    expect(Object.isFrozen(pad.buttons)).toBe(true);
    expect(pad.buttons.every((button) => Object.isFrozen(button))).toBe(true);
    expect(Object.isFrozen(pad.axes)).toBe(true);
  });

  it('never changes a snapshot it already handed out', () => {
    const fake = createFakeGamepads();
    const pad = fake.connect();
    const before = fake.environment.getGamepads()[0]!;
    pad.hold('south');
    pad.stick(0.8, -0.2);
    expect(before.buttons[0]!.pressed).toBe(false);
    expect(before.axes.slice(0, 2)).toEqual([0, 0]);
    const after = fake.environment.getGamepads()[0]!;
    expect(after.buttons[0]!.pressed).toBe(true);
    expect(after.axes.slice(0, 2)).toEqual([0.8, -0.2]);
  });

  it('puts each button where the standard mapping has it', () => {
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
      const fake = createFakeGamepads();
      const pad = fake.connect();
      pad.hold(input);
      const down = fake.environment.getGamepads()[0]!.buttons.flatMap((button, place) => (button.pressed ? [place] : []));
      expect(down).toEqual([index]);
      pad.release(input);
      expect(fake.environment.getGamepads()[0]!.buttons.some((button) => button.pressed)).toBe(false);
    }
  });

  it('pushes the stick all the way for a held stick input, with up as negative y, and centres it on release', () => {
    const fake = createFakeGamepads();
    const pad = fake.connect();
    const stick = () => fake.environment.getGamepads()[0]!.axes.slice(0, 2);
    pad.hold('stick-up');
    expect(stick()).toEqual([0, -1]);
    pad.hold('stick-right');
    expect(stick()).toEqual([1, 0]);
    pad.release('stick-right');
    expect(stick()).toEqual([0, 0]);
  });

  it('leaves the stick where it is on release of a stick input it is not pushed toward', () => {
    const fake = createFakeGamepads();
    const pad = fake.connect();
    const stick = () => fake.environment.getGamepads()[0]!.axes.slice(0, 2);
    pad.hold('stick-right');
    pad.release('stick-up');
    pad.release('stick-left');
    expect(stick()).toEqual([1, 0]);
    pad.stick(0.6, -0.6);
    pad.release('stick-down');
    expect(stick()).toEqual([0.6, -0.6]);
    pad.release('stick-up');
    expect(stick()).toEqual([0, 0]);
  });

  it('leaves null in the place of a disconnected pad, and the other pads where they were', () => {
    const fake = createFakeGamepads();
    const first = fake.connect();
    const second = fake.connect();
    second.hold('east');
    first.disconnect();
    const pads = fake.environment.getGamepads();
    expect(pads).toHaveLength(2);
    expect(pads[0]).toBeNull();
    expect(pads[1]!.buttons[1]!.pressed).toBe(true);
  });

  it('throws from getGamepads once forbidden', () => {
    const fake = createFakeGamepads();
    fake.connect();
    fake.forbid();
    expect(() => fake.environment.getGamepads()).toThrow();
  });
});
