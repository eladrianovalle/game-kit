import { describe, expect, it } from 'vitest';
import { createFakePage, createPointerEvent, placeElement } from '../testing/fake-page';
import { createActions } from './actions';
import { createTouchControls, padDirection, type TouchControl } from './touch';

const ACTIONS = ['up', 'down', 'left', 'right', 'action'] as const;
type Action = (typeof ACTIONS)[number];

const CONTROLS: readonly TouchControl<Action>[] = [
  { kind: 'pad', up: 'up', down: 'down', left: 'left', right: 'right', label: 'Move' },
  { kind: 'button', action: 'action', label: 'Boost' },
];

/** Where the tests say the pad is: 120 wide, so its centre is at (160, 260). */
const PAD_BOX = { left: 100, top: 200, width: 120, height: 120 };
const PAD_CENTRE = { clientX: 160, clientY: 260 };
const ON_RIGHT_HALF = { clientX: 200, clientY: 260 };
const ON_TOP_HALF = { clientX: 160, clientY: 215 };

function setUp() {
  const { document, hostElement: container } = createFakePage();
  const actions = createActions(ACTIONS);
  const controls = createTouchControls(container, actions, CONTROLS);
  const pad = container.querySelector<HTMLElement>('[data-touch-control="pad"]')!;
  const button = container.querySelector<HTMLElement>('[data-touch-control="button"]')!;
  // The fake page does no layout, so the pad is told where it is.
  placeElement(pad, PAD_BOX);
  const pointer = (target: HTMLElement, type: string, at: { clientX: number; clientY: number; pointerId?: number }): void => {
    target.dispatchEvent(createPointerEvent(document, type, at));
  };
  const heldActions = (): Action[] => {
    const held = actions.take().held;
    return ACTIONS.filter((action) => held[action]);
  };
  return { container, actions, controls, pad, button, pointer, heldActions };
}

describe('padDirection', () => {
  it('returns each of the four directions on its axis', () => {
    expect(padDirection(40, 0, 10)).toBe('right');
    expect(padDirection(-40, 0, 10)).toBe('left');
    // Page pixels count downward, so a negative offset is above the centre.
    expect(padDirection(0, -40, 10)).toBe('up');
    expect(padDirection(0, 40, 10)).toBe('down');
  });

  it('returns null inside the dead zone, however the thumb is offset there', () => {
    expect(padDirection(0, 0, 10)).toBeNull();
    expect(padDirection(6, -6, 10)).toBeNull();
    expect(padDirection(-10, 0, 10)).toBeNull();
    expect(padDirection(0, 0, 0)).toBeNull();
  });

  it('off the axes, returns the nearest of the four', () => {
    expect(padDirection(40, 15, 10)).toBe('right');
    expect(padDirection(-15, -40, 10)).toBe('up');
    expect(padDirection(15, 40, 10)).toBe('down');
    expect(padDirection(-40, -15, 10)).toBe('left');
  });
});

describe('touch controls', () => {
  it('builds one pad and one real button inside the container, both with touch-action none', () => {
    const { container, pad, button } = setUp();
    expect(container.children.length).toBe(2);
    expect(container.querySelectorAll('[data-touch-control="pad"]').length).toBe(1);
    expect(container.querySelectorAll('[data-touch-control="button"]').length).toBe(1);
    expect(pad.getAttribute('aria-label')).toBe('Move');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Boost');
    expect(pad.style.touchAction).toBe('none');
    expect(button.style.touchAction).toBe('none');
  });

  it('holds right while a pointer is down on the right half of the pad, and releases it on pointer up', () => {
    const { pad, pointer, heldActions } = setUp();
    pointer(pad, 'pointerdown', ON_RIGHT_HALF);
    expect(heldActions()).toEqual(['right']);
    pointer(pad, 'pointerup', ON_RIGHT_HALF);
    expect(heldActions()).toEqual([]);
  });

  it('follows the thumb: moving to the top half lets go of right and holds up', () => {
    const { pad, pointer, heldActions } = setUp();
    pointer(pad, 'pointerdown', ON_RIGHT_HALF);
    pointer(pad, 'pointermove', ON_TOP_HALF);
    expect(heldActions()).toEqual(['up']);
    // Back on the middle the thumb means nothing.
    pointer(pad, 'pointermove', PAD_CENTRE);
    expect(heldActions()).toEqual([]);
  });

  it('holds nothing for a pointer that goes down on the middle of the pad', () => {
    const { pad, pointer, heldActions } = setUp();
    pointer(pad, 'pointerdown', PAD_CENTRE);
    expect(heldActions()).toEqual([]);
  });

  it('follows one finger only: a second on the pad neither steers nor lets go', () => {
    const { pad, pointer, heldActions } = setUp();
    pointer(pad, 'pointerdown', { ...ON_RIGHT_HALF, pointerId: 1 });
    pointer(pad, 'pointerdown', { ...ON_TOP_HALF, pointerId: 2 });
    pointer(pad, 'pointermove', { ...ON_TOP_HALF, pointerId: 2 });
    pointer(pad, 'pointerup', { ...ON_TOP_HALF, pointerId: 2 });
    expect(heldActions()).toEqual(['right']);
    pointer(pad, 'pointerup', { ...ON_RIGHT_HALF, pointerId: 1 });
    expect(heldActions()).toEqual([]);
  });

  it('lets go when the browser cancels the touch', () => {
    const { pad, pointer, heldActions } = setUp();
    pointer(pad, 'pointerdown', ON_RIGHT_HALF);
    pointer(pad, 'pointercancel', ON_RIGHT_HALF);
    expect(heldActions()).toEqual([]);
  });

  it('the button presses its action once per tap', () => {
    const { button, pointer, actions } = setUp();
    const at = { clientX: 300, clientY: 260 };

    pointer(button, 'pointerdown', at);
    pointer(button, 'pointerup', at);
    // A tap that starts and ends between two steps is still seen, once.
    const first = actions.take();
    expect(first.pressed.action).toBe(true);
    expect(first.held.action).toBe(false);
    expect(actions.take().pressed.action).toBe(false);

    pointer(button, 'pointerdown', at);
    expect(actions.take().pressed.action).toBe(true);
    // Still down a step later: held, and not pressed again.
    const stillDown = actions.take();
    expect(stillDown.held.action).toBe(true);
    expect(stillDown.pressed.action).toBe(false);
    pointer(button, 'pointerup', at);
    expect(actions.take().held.action).toBe(false);
  });

  it('on dispose removes the controls and lets go of what they held', () => {
    const { container, controls, pad, button, pointer, heldActions } = setUp();
    pointer(pad, 'pointerdown', ON_RIGHT_HALF);
    pointer(button, 'pointerdown', { clientX: 300, clientY: 260 });
    expect(heldActions()).toEqual(['right', 'action']);

    controls.dispose();
    expect(container.children.length).toBe(0);
    expect(heldActions()).toEqual([]);
  });
});
