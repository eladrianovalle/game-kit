// A time source for tests: animation frames that happen only when the test says so.

import { STEP_MS, type ClockEnvironment } from '../kit/clock';

export function createFakeTime() {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, (time: number) => void>();
  const environment: ClockEnvironment = {
    now: () => now,
    requestFrame(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      pending.delete(handle);
    },
  };
  return {
    environment,
    pendingFrames: () => pending.size,
    /** Let `elapsedMs` pass (one step's worth unless told otherwise), then run the frame that was waiting. */
    frame(elapsedMs: number = STEP_MS) {
      now += elapsedMs;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback(now);
      }
    },
  };
}
