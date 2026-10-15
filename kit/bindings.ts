// One table per game, keyed by action, that says which keys and pad inputs give
// each action and how to describe it to the player. The keyboard, the pad and a
// game's Controls page all read it, so the page cannot fall out of date.

import type { KeyBindings } from './keyboard';

/** A pad control, named by where it sits on a pad with the browser's `standard` mapping. */
export type PadInput =
  | 'south' | 'east' | 'west' | 'north' | 'left-bumper' | 'right-bumper' | 'start'
  | 'dpad-up' | 'dpad-down' | 'dpad-left' | 'dpad-right'
  | 'stick-up' | 'stick-down' | 'stick-left' | 'stick-right';

export interface Binding {
  /** What the action does, in the player's words. A Controls page prints it. */
  label: string;
  /** `KeyboardEvent.code` values. */
  keys?: readonly string[];
  pad?: readonly PadInput[];
  /** Words only ("Swipe up"). The kit cannot read a game's gestures. */
  touch?: string;
}

/** One entry per action: the single place a game says what gives it. */
export type Bindings<A extends string> = Readonly<Record<A, Binding>>;
export type PadBindings<A extends string> = Readonly<Partial<Record<PadInput, A>>>;

/**
 * Turns the table round, from action-to-inputs into input-to-action. Throws if
 * one input is given to two actions, because only one of them could ever get it.
 */
function actionByInput<A extends string>(
  table: Bindings<A>,
  kind: 'key' | 'pad input',
  inputsOf: (binding: Binding) => readonly string[] | undefined,
): Map<string, A> {
  const actionFor = new Map<string, A>();
  for (const action of Object.keys(table) as A[]) {
    for (const input of inputsOf(table[action]) ?? []) {
      const earlier = actionFor.get(input);
      if (earlier !== undefined && earlier !== action) {
        throw new Error(`The ${kind} '${input}' is given to two actions: '${earlier}' and '${action}'.`);
      }
      actionFor.set(input, action);
    }
  }
  return actionFor;
}

/** The `KeyBindings` that `bindKeyboard` takes. Throws if one key is given to two actions. */
export function keyBindingsFrom<A extends string>(table: Bindings<A>): KeyBindings<A> {
  return Object.fromEntries(actionByInput(table, 'key', (binding) => binding.keys));
}

/** Pad input to action. Throws if one pad input is given to two actions. */
export function padBindingsFrom<A extends string>(table: Bindings<A>): PadBindings<A> {
  return Object.fromEntries(actionByInput(table, 'pad input', (binding) => binding.pad));
}

export interface ControlsRow<A extends string> {
  action: A;
  label: string;
  keys: string[];
  pad: string[];
  touch: string | null;
}

/** The rows of a Controls page, in `order`, with every key and pad input already a label. */
export function controlsRows<A extends string>(
  table: Bindings<A>,
  order: readonly A[],
  labels: {
    keys?: Readonly<Record<string, string>>;
    pad?: Readonly<Partial<Record<PadInput, string>>>;
  } = {},
): ControlsRow<A>[] {
  const keyLabels = labels.keys ?? {};
  const padLabels = labels.pad ?? {};
  return order.map((action) => {
    const binding = table[action];
    return {
      action,
      label: binding.label,
      // An own-property check, so a key code that is also the name of something
      // every object has ('constructor') still gets its default label.
      keys: (binding.keys ?? []).map((code) =>
        Object.prototype.hasOwnProperty.call(keyLabels, code) ? keyLabels[code]! : keyLabel(code),
      ),
      pad: (binding.pad ?? []).map((input) => padLabels[input] ?? padLabel(input)),
      touch: binding.touch ?? null,
    };
  });
}

const ARROW_KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  ArrowLeft: 'Left arrow',
  ArrowRight: 'Right arrow',
};

/**
 * 'ArrowUp' gives 'Up arrow', 'KeyW' gives 'W': the letter a US keyboard prints there.
 * A code not known here comes back unchanged, which already reads well for
 * 'Space', 'Escape' and 'Enter'. A game that knows better passes its own labels
 * to `controlsRows`.
 */
export function keyLabel(code: string): string {
  if (Object.prototype.hasOwnProperty.call(ARROW_KEY_LABELS, code)) {
    return ARROW_KEY_LABELS[code]!;
  }
  const letterOrDigit = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (letterOrDigit !== null) {
    return letterOrDigit[1] ?? letterOrDigit[2]!;
  }
  return code;
}

// Buttons are named by position, because the kit does not guess who made the pad.
const PAD_LABELS: Readonly<Record<PadInput, string>> = {
  south: 'Bottom button',
  east: 'Right button',
  west: 'Left button',
  north: 'Top button',
  'left-bumper': 'Left bumper',
  'right-bumper': 'Right bumper',
  start: 'Start',
  'dpad-up': 'D-pad up',
  'dpad-down': 'D-pad down',
  'dpad-left': 'D-pad left',
  'dpad-right': 'D-pad right',
  'stick-up': 'Stick up',
  'stick-down': 'Stick down',
  'stick-left': 'Stick left',
  'stick-right': 'Stick right',
};

/** 'south' gives 'Bottom button', 'left-bumper' gives 'Left bumper', 'stick-up' gives 'Stick up'. */
export function padLabel(input: PadInput): string {
  return PAD_LABELS[input];
}
