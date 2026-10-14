import { describe, expect, it } from 'vitest';
import { createActions } from './actions';

const NAMES = ['left', 'jump'] as const;

describe('actions', () => {
  it('holds an action while at least one source holds it', () => {
    const actions = createActions(NAMES);
    actions.press('left', 'ArrowLeft');
    actions.press('left', 'KeyA');
    actions.release('left', 'ArrowLeft');
    expect(actions.take().held.left).toBe(true);
    actions.release('left', 'KeyA');
    expect(actions.take().held.left).toBe(false);
  });

  it('reports a press for exactly one take', () => {
    const actions = createActions(NAMES);
    actions.press('jump', 'KeyZ');
    expect(actions.take().pressed.jump).toBe(true);
    const second = actions.take();
    expect(second.pressed.jump).toBe(false);
    expect(second.held.jump).toBe(true);
  });

  it('still reports a tap that started and ended between two takes', () => {
    const actions = createActions(NAMES);
    actions.press('jump', 'KeyZ');
    actions.release('jump', 'KeyZ');
    const snapshot = actions.take();
    expect(snapshot.pressed.jump).toBe(true);
    expect(snapshot.held.jump).toBe(false);
  });

  it('does not press again when a second source joins an action already held', () => {
    const actions = createActions(NAMES);
    actions.press('left', 'ArrowLeft');
    actions.take();
    actions.press('left', 'KeyA');
    expect(actions.take().pressed.left).toBe(false);
  });

  it('releaseAll lets go of every source of every action', () => {
    const actions = createActions(NAMES);
    actions.press('left', 'ArrowLeft');
    actions.press('jump', 'KeyZ');
    actions.releaseAll();
    expect(actions.take().held).toEqual({ left: false, jump: false });
  });
});
