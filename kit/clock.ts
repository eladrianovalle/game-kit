// Turns animation frames into fixed 60 Hz steps. A frame that took longer than
// one step runs several steps to catch up, up to a cap; past the cap the game
// slows down instead of trying to make up ever more time.

export const STEP_MS = 1000 / 60;
export const MAX_STEPS_PER_FRAME = 5;
export const MAX_FRAME_MS = 250;

/**
 * Frame times are sums and differences of fractions, so a frame exactly one step
 * long can measure a hair under `STEP_MS`. This much shortfall still counts as a
 * whole step.
 */
const STEP_ROUNDING_SLACK_MS = 0.001;

export interface Clock {
  /** May steps run? When false, frames still call `draw`, and no time is owed on resume. */
  setRunning(running: boolean): void;
  isRunning(): boolean;
  dispose(): void;
}

export interface ClockEnvironment {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
}

export function createClock(config: {
  /** One fixed step. */
  step(): void;
  /** Once per animation frame, after the steps. */
  draw(): void;
  environment: ClockEnvironment;
}): Clock {
  const { step, draw, environment } = config;
  let running = false;
  let disposed = false;
  let lastFrameTime = environment.now();
  let owedMs = 0;
  let pendingFrame = 0;

  const onFrame = (time: number): void => {
    const elapsedMs = Math.min(time - lastFrameTime, MAX_FRAME_MS);
    lastFrameTime = time;

    if (running) {
      owedMs += elapsedMs;
      let stepsRun = 0;
      // `running` is checked every time round because a step may stop the clock,
      // for example by ending the run.
      while (running && stepsRun < MAX_STEPS_PER_FRAME && owedMs >= STEP_MS - STEP_ROUNDING_SLACK_MS) {
        step();
        owedMs = Math.max(owedMs - STEP_MS, 0);
        stepsRun += 1;
      }
      if (stepsRun === MAX_STEPS_PER_FRAME) {
        owedMs = 0;
      }
    }

    // A step may have disposed the clock.
    if (disposed) {
      return;
    }
    draw();
    if (!disposed) {
      pendingFrame = environment.requestFrame(onFrame);
    }
  };

  pendingFrame = environment.requestFrame(onFrame);

  return {
    setRunning(nextRunning) {
      if (nextRunning && !running) {
        owedMs = 0;
      }
      running = nextRunning;
    },
    isRunning() {
      return running;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      running = false;
      environment.cancelFrame(pendingFrame);
    },
  };
}
