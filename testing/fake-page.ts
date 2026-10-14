// A document for tests that need one, with a host element already in the page.

import { Window } from 'happy-dom';

export interface FakePage {
  document: Document;
  /** The empty element a host hands a game. */
  hostElement: HTMLElement;
}

export function createFakePage(): FakePage {
  const window = new Window();
  // happy-dom's types are its own; to the code under test this is a Document.
  const document = window.document as unknown as Document;
  const hostElement = document.createElement('div');
  document.body.append(hostElement);
  return { document, hostElement };
}

/** Build an event the fake page's elements will accept: happy-dom takes only its own. */
export function createPageEvent(document: Document, type: string): Event {
  const window = document.defaultView as unknown as { Event: typeof Event };
  return new window.Event(type);
}

/** A pointer event at a point of the page, for a finger or a mouse. */
export function createPointerEvent(
  document: Document,
  type: string,
  at: { clientX: number; clientY: number; pointerId?: number },
): PointerEvent {
  const window = document.defaultView as unknown as { PointerEvent: typeof PointerEvent };
  return new window.PointerEvent(type, { pointerId: 1, ...at, bubbles: true, cancelable: true });
}

/** Stand in for layout, which the fake page does not do: say where an element is on the page. */
export function placeElement(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box }) as DOMRect;
}
