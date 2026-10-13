import { describe, expect, it } from 'vitest';
import { createRecordingTarget } from '../testing/recording-target';
import { createActions } from './actions';
import {
  controlsRows,
  keyBindingsFrom,
  keyLabel,
  padBindingsFrom,
  padLabel,
  type Bindings,
  type PadInput,
} from './bindings';
import { bindKeyboard } from './keyboard';

type Action = 'up' | 'pause' | 'use';

const TABLE: Bindings<Action> = {
  up: { label: 'Step up', keys: ['ArrowUp', 'KeyW'], pad: ['dpad-up', 'stick-up'], touch: 'Swipe up' },
  pause: { label: 'Pause', keys: ['Escape'], pad: ['start'] },
  use: { label: 'Use', keys: ['Space'] },
};

/** Typed as a full record, so adding a `PadInput` without listing it here fails the type check. */
const EVERY_PAD_INPUT: Record<PadInput, true> = {
  south: true,
  east: true,
  west: true,
  north: true,
  'left-bumper': true,
  'right-bumper': true,
  start: true,
  'dpad-up': true,
  'dpad-down': true,
  'dpad-left': true,
  'dpad-right': true,
  'stick-up': true,
  'stick-down': true,
  'stick-left': true,
  'stick-right': true,
};
const PAD_INPUTS = Object.keys(EVERY_PAD_INPUT) as PadInput[];

describe('keyBindingsFrom', () => {
  it('gives every key its action', () => {
    expect(keyBindingsFrom(TABLE)).toEqual({ ArrowUp: 'up', KeyW: 'up', Escape: 'pause', Space: 'use' });
  });

  it('gives bindings a keyboard can press an action through', () => {
    const target = createRecordingTarget();
    const actions = createActions(['up', 'pause', 'use'] as const);
    bindKeyboard({
      actions,
      bindings: keyBindingsFrom(TABLE),
      isCapturing: () => true,
      target: target as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    });

    target.dispatch('keydown', {
      code: 'KeyW',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: () => {},
    });

    const snapshot = actions.take();
    expect(snapshot.pressed).toEqual({ up: true, pause: false, use: false });
    expect(snapshot.held.up).toBe(true);
  });

  it('throws, naming the key and both actions, when one key is given to two actions', () => {
    const table: Bindings<Action> = { ...TABLE, use: { label: 'Use', keys: ['KeyE', 'KeyW'] } };
    expect(() => keyBindingsFrom(table)).toThrow("The key 'KeyW' is given to two actions: 'up' and 'use'.");
  });

  it('leaves out an action that has no keys', () => {
    const table: Bindings<'up' | 'use'> = { up: { label: 'Step up', keys: ['KeyW'] }, use: { label: 'Use', pad: ['south'] } };
    expect(keyBindingsFrom(table)).toEqual({ KeyW: 'up' });
  });
});

describe('padBindingsFrom', () => {
  it('gives every pad input its action', () => {
    expect(padBindingsFrom(TABLE)).toEqual({ 'dpad-up': 'up', 'stick-up': 'up', start: 'pause' });
  });

  it('throws, naming the pad input and both actions, when one pad input is given to two actions', () => {
    const table: Bindings<Action> = { ...TABLE, use: { label: 'Use', pad: ['south', 'start'] } };
    expect(() => padBindingsFrom(table)).toThrow("The pad input 'start' is given to two actions: 'pause' and 'use'.");
  });

  it('does not mind a key shared by two actions, which is the keyboard table’s to refuse', () => {
    const table: Bindings<Action> = { ...TABLE, use: { label: 'Use', keys: ['KeyW'], pad: ['south'] } };
    expect(padBindingsFrom(table).south).toBe('use');
  });
});

describe('controlsRows', () => {
  it('returns the rows in the order asked, with default labels for keys and pad inputs', () => {
    expect(controlsRows(TABLE, ['pause', 'use', 'up'])).toEqual([
      { action: 'pause', label: 'Pause', keys: ['Escape'], pad: ['Start'], touch: null },
      { action: 'use', label: 'Use', keys: ['Space'], pad: [], touch: null },
      { action: 'up', label: 'Step up', keys: ['Up arrow', 'W'], pad: ['D-pad up', 'Stick up'], touch: 'Swipe up' },
    ]);
  });

  it('labels each key with keyLabel and each pad input with padLabel', () => {
    const [row] = controlsRows(TABLE, ['up']);
    expect(row!.keys).toEqual(TABLE.up.keys!.map(keyLabel));
    expect(row!.pad).toEqual(TABLE.up.pad!.map(padLabel));
  });

  it('prints only the actions asked for', () => {
    expect(controlsRows(TABLE, ['use']).map((row) => row.action)).toEqual(['use']);
  });

  it('uses a label passed in instead of the default, and keeps the default for the rest', () => {
    const rows = controlsRows(TABLE, ['up', 'pause'], {
      keys: { KeyW: 'Z', Escape: 'Esc' },
      pad: { 'dpad-up': 'Up on the cross', start: 'Options' },
    });
    expect(rows[0]).toMatchObject({ keys: ['Up arrow', 'Z'], pad: ['Up on the cross', 'Stick up'] });
    expect(rows[1]).toMatchObject({ keys: ['Esc'], pad: ['Options'] });
  });

  it('gives a key code that is also the name of an object’s own machinery its default label', () => {
    const table: Bindings<'odd'> = { odd: { label: 'Odd', keys: ['constructor'] } };
    expect(controlsRows(table, ['odd'], { keys: {} })[0]!.keys).toEqual(['constructor']);
  });
});

describe('keyLabel', () => {
  it.each([
    ['ArrowUp', 'Up arrow'],
    ['ArrowDown', 'Down arrow'],
    ['ArrowLeft', 'Left arrow'],
    ['ArrowRight', 'Right arrow'],
    ['KeyW', 'W'],
    ['Digit1', '1'],
    ['Space', 'Space'],
  ])('labels %s as %s', (code, label) => {
    expect(keyLabel(code)).toBe(label);
  });

  it.each(['IntlBackslash', 'KeyboardLayout', 'Digit10', 'toString'])('returns %s, a code it does not know, unchanged', (code) => {
    expect(keyLabel(code)).toBe(code);
  });
});

describe('padLabel', () => {
  it.each(PAD_INPUTS)('has a label for %s', (input) => {
    expect(padLabel(input).trim()).not.toBe('');
  });

  it('gives every pad input a label of its own', () => {
    expect(new Set(PAD_INPUTS.map(padLabel)).size).toBe(PAD_INPUTS.length);
  });

  it('names a button by where it sits', () => {
    expect(padLabel('south')).toBe('Bottom button');
    expect(padLabel('left-bumper')).toBe('Left bumper');
    expect(padLabel('stick-up')).toBe('Stick up');
  });
});
