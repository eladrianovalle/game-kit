import { describe, expect, it } from 'vitest';
import { createRepeat } from './repeat';

type Direction = 'up' | 'down';

/** The steps, counted from 0, on which `step` returned something. */
function firedSteps(repeat: { step(held: Direction | null): Direction | null }, held: Direction, count: number): number[] {
  const fired: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (repeat.step(held) !== null) {
      fired.push(index);
    }
  }
  return fired;
}

describe('createRepeat', () => {
  it('fires on the first held step, on the step delaySteps later, then every intervalSteps', () => {
    const repeat = createRepeat<Direction>({ delaySteps: 5, intervalSteps: 2 });
    expect(firedSteps(repeat, 'up', 12)).toEqual([0, 5, 7, 9, 11]);
  });

  it('returns the held direction on the steps it fires and null on the others', () => {
    const repeat = createRepeat<Direction>({ delaySteps: 2, intervalSteps: 1 });
    expect([repeat.step('down'), repeat.step('down'), repeat.step('down'), repeat.step('down')]).toEqual(['down', null, 'down', 'down']);
  });

  it('returns null while nothing is held', () => {
    const repeat = createRepeat<Direction>({ delaySteps: 2, intervalSteps: 1 });
    expect([repeat.step(null), repeat.step(null), repeat.step(null)]).toEqual([null, null, null]);
  });

  it('starts over when the direction changes', () => {
    const repeat = createRepeat<Direction>({ delaySteps: 5, intervalSteps: 2 });
    firedSteps(repeat, 'up', 4);
    // One step short of the first repeat of 'up': 'down' acts at once and waits the full delay.
    expect(firedSteps(repeat, 'down', 8)).toEqual([0, 5, 7]);
  });

  it('starts over after a step with nothing held, even for the same direction', () => {
    const repeat = createRepeat<Direction>({ delaySteps: 5, intervalSteps: 2 });
    firedSteps(repeat, 'up', 4);
    expect(repeat.step(null)).toBeNull();
    expect(firedSteps(repeat, 'up', 8)).toEqual([0, 5, 7]);
  });

  it('throws on a tuning number that could never work, naming it', () => {
    expect(() => createRepeat<Direction>({ delaySteps: 5, intervalSteps: 0 })).toThrow(/intervalSteps/);
    expect(() => createRepeat<Direction>({ delaySteps: 5, intervalSteps: 1.5 })).toThrow(/intervalSteps/);
    expect(() => createRepeat<Direction>({ delaySteps: -1, intervalSteps: 2 })).toThrow(/delaySteps/);
  });
});
