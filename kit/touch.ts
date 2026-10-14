// On-screen controls for a touch screen, built as page elements from a list the
// game declares. They feed the same actions the keyboard does.

import type { Actions } from './actions';
import { createDisposer, type Disposer } from './lifecycle';

export type TouchControl<A extends string> =
  | { kind: 'pad'; up: A; down: A; left: A; right: A; label: string }
  | { kind: 'button'; action: A; label: string };

export type PadDirection = 'up' | 'down' | 'left' | 'right';

/**
 * How far from the pad's centre a thumb must be before it means a direction, as
 * a share of the pad's width. A thumb resting on the middle holds nothing.
 */
const PAD_DEAD_ZONE_SHARE = 0.12;

/**
 * Which direction a thumb at this offset from the pad's centre means, or null
 * inside the dead zone. Offsets are in page pixels, so a positive `offsetY` is
 * below the centre. Pure.
 */
export function padDirection(offsetX: number, offsetY: number, deadZone: number): PadDirection | null {
  if (Math.hypot(offsetX, offsetY) <= deadZone) {
    return null;
  }
  if (Math.abs(offsetX) >= Math.abs(offsetY)) {
    return offsetX > 0 ? 'right' : 'left';
  }
  return offsetY > 0 ? 'down' : 'up';
}

/**
 * Builds the controls inside `container`, in the order given, and wires them.
 * Disposing removes them and lets go of anything they were holding.
 */
export function createTouchControls<A extends string>(
  container: HTMLElement,
  actions: Actions<A>,
  controls: readonly TouchControl<A>[],
): Disposer {
  const disposer = createDisposer();
  controls.forEach((control, index) => {
    // Each control is its own source, so two controls bound to one action do
    // not let go of each other's hold.
    const source = `touch:${control.kind}:${index}`;
    const built = control.kind === 'pad' ? buildPad(container, actions, control, source) : buildButton(container, actions, control, source);
    container.append(built.element);
    disposer.add(() => {
      built.letGo();
      built.element.remove();
    });
  });
  return disposer;
}

interface BuiltControl {
  element: HTMLElement;
  /** Release whatever the control holds. */
  letGo(): void;
}

/** One element that follows the thumb and holds the nearest of four directions. */
function buildPad<A extends string>(
  container: HTMLElement,
  actions: Actions<A>,
  control: Extract<TouchControl<A>, { kind: 'pad' }>,
  source: string,
): BuiltControl {
  const pad = container.ownerDocument.createElement('div');
  pad.dataset.touchControl = 'pad';
  pad.setAttribute('role', 'group');
  pad.setAttribute('aria-label', control.label);
  // Without this the browser would scroll or zoom the page under the thumb.
  pad.style.touchAction = 'none';

  /** The one finger the pad follows. A second finger on the pad is ignored. */
  let followedPointer: number | null = null;
  let heldAction: A | null = null;

  const hold = (action: A | null): void => {
    if (action === heldAction) {
      return;
    }
    if (heldAction !== null) {
      actions.release(heldAction, source);
    }
    if (action !== null) {
      actions.press(action, source);
    }
    heldAction = action;
  };

  const follow = (event: PointerEvent): void => {
    const box = pad.getBoundingClientRect();
    const offsetX = event.clientX - (box.left + box.width / 2);
    const offsetY = event.clientY - (box.top + box.height / 2);
    const direction = padDirection(offsetX, offsetY, box.width * PAD_DEAD_ZONE_SHARE);
    hold(direction === null ? null : control[direction]);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId === followedPointer) {
      followedPointer = null;
      hold(null);
    }
  };

  pad.addEventListener('pointerdown', (event) => {
    if (followedPointer !== null) {
      return;
    }
    followedPointer = event.pointerId;
    // Capture keeps the moves and the lift coming to the pad when the thumb
    // slides off its edge.
    pad.setPointerCapture(event.pointerId);
    event.preventDefault();
    follow(event);
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId === followedPointer) {
      follow(event);
    }
  });
  pad.addEventListener('pointerup', onPointerEnd);
  pad.addEventListener('pointercancel', onPointerEnd);
  pad.addEventListener('lostpointercapture', onPointerEnd);

  return { element: pad, letGo: () => hold(null) };
}

/** A real button that holds its action while a finger is down on it. */
function buildButton<A extends string>(
  container: HTMLElement,
  actions: Actions<A>,
  control: Extract<TouchControl<A>, { kind: 'button' }>,
  source: string,
): BuiltControl {
  const button = container.ownerDocument.createElement('button');
  button.type = 'button';
  button.dataset.touchControl = 'button';
  button.textContent = control.label;
  button.style.touchAction = 'none';

  const letGo = (): void => actions.release(control.action, source);

  button.addEventListener('pointerdown', (event) => {
    button.setPointerCapture(event.pointerId);
    actions.press(control.action, source);
  });
  button.addEventListener('pointerup', letGo);
  button.addEventListener('pointercancel', letGo);
  button.addEventListener('lostpointercapture', letGo);

  return { element: button, letGo };
}
