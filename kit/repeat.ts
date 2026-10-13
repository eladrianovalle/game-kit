// A held direction repeats the way a held key does in a text box. It reads what
// is held and knows nothing of pads, so a held arrow key can use it too.

/**
 * Turns "this direction is held" into "act now": once when it goes down, again
 * after `delaySteps`, then every `intervalSteps`. A change of direction starts over.
 */
export function createRepeat<D extends string>(config: { delaySteps: number; intervalSteps: number }): {
  /** Call once per clock step with the held direction or null. Returns it on the steps to act. */
  step(held: D | null): D | null;
} {
  const { delaySteps, intervalSteps } = config;
  let current: D | null = null;
  let stepsSinceFirst = 0;

  return {
    step(held) {
      if (held === null) {
        current = null;
        return null;
      }
      if (held !== current) {
        current = held;
        stepsSinceFirst = 0;
        return held;
      }
      stepsSinceFirst += 1;
      if (stepsSinceFirst < delaySteps) {
        return null;
      }
      const stepsSinceDelay = stepsSinceFirst - delaySteps;
      return stepsSinceDelay % intervalSteps === 0 ? held : null;
    },
  };
}
