import { describe, expect, it } from 'vitest';
import { createFakeTime } from '../testing/fake-time';
import { createClock, MAX_STEPS_PER_FRAME, STEP_MS, type Clock } from './clock';

function createCountingClock() {
  const time = createFakeTime();
  const counts = { steps: 0, draws: 0 };
  const clock: Clock = createClock({
    step: () => {
      counts.steps += 1;
    },
    draw: () => {
      counts.draws += 1;
    },
    environment: time.environment,
  });
  return { time, counts, clock };
}

describe('clock', () => {
  it('runs six steps over six frames of STEP_MS each', () => {
    const { time, counts, clock } = createCountingClock();
    clock.setRunning(true);
    for (let frame = 0; frame < 6; frame += 1) {
      time.frame(STEP_MS);
    }
    expect(counts.steps).toBe(6);
    expect(counts.draws).toBe(6);
  });

  it('runs MAX_STEPS_PER_FRAME steps on one 2-second frame and owes nothing after', () => {
    const { time, counts, clock } = createCountingClock();
    clock.setRunning(true);
    time.frame(2000);
    expect(counts.steps).toBe(MAX_STEPS_PER_FRAME);

    // Had the dropped time still been owed, this frame would run the cap again.
    time.frame(STEP_MS);
    expect(counts.steps).toBe(MAX_STEPS_PER_FRAME + 1);
  });

  it('runs no step while setRunning(false), but still draws', () => {
    const { time, counts, clock } = createCountingClock();
    expect(clock.isRunning()).toBe(false);
    for (let frame = 0; frame < 10; frame += 1) {
      time.frame(STEP_MS);
    }
    expect(counts.steps).toBe(0);
    expect(counts.draws).toBe(10);
  });

  it('owes none of the paused time on resume', () => {
    const { time, counts, clock } = createCountingClock();
    clock.setRunning(true);
    time.frame(STEP_MS);
    expect(counts.steps).toBe(1);

    clock.setRunning(false);
    for (let frame = 0; frame < 30; frame += 1) {
      time.frame(STEP_MS * 3.5);
    }
    expect(counts.steps).toBe(1);

    clock.setRunning(true);
    time.frame(STEP_MS);
    expect(counts.steps).toBe(2);
  });

  it('carries a part step over to the next frame', () => {
    const { time, counts, clock } = createCountingClock();
    clock.setRunning(true);
    time.frame(STEP_MS * 1.5);
    expect(counts.steps).toBe(1);
    time.frame(STEP_MS * 1.5);
    expect(counts.steps).toBe(3);
  });

  it('stops stepping within a frame when a step stops the clock', () => {
    const time = createFakeTime();
    let steps = 0;
    const clock = createClock({
      step: () => {
        steps += 1;
        clock.setRunning(false);
      },
      draw: () => {},
      environment: time.environment,
    });
    clock.setRunning(true);
    time.frame(STEP_MS * 4);
    expect(steps).toBe(1);
  });

  it('leaves no frame pending after dispose, and runs no step and no draw', () => {
    const { time, counts, clock } = createCountingClock();
    clock.setRunning(true);
    time.frame(STEP_MS);
    expect(time.pendingFrames()).toBe(1);

    clock.dispose();
    expect(time.pendingFrames()).toBe(0);
    time.frame(STEP_MS);
    expect(counts).toEqual({ steps: 1, draws: 1 });
  });

  it('does not draw or ask for another frame when a step disposes it', () => {
    const time = createFakeTime();
    let draws = 0;
    const clock = createClock({
      step: () => clock.dispose(),
      draw: () => {
        draws += 1;
      },
      environment: time.environment,
    });
    clock.setRunning(true);
    time.frame(STEP_MS);
    expect(draws).toBe(0);
    expect(time.pendingFrames()).toBe(0);
  });
});
