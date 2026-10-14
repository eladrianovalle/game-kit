// A stand-in for anything that takes event listeners (a window, a document, a
// media query) that remembers what was added and removed, so a test can check
// that nothing is left listening.

type Listener = (event: unknown) => void;

export function createRecordingTarget() {
  const listeners = new Map<string, Set<Listener>>();
  const added: string[] = [];
  const removed: string[] = [];

  return {
    addEventListener(type: string, listener: Listener): void {
      added.push(type);
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener): void {
      if (listeners.get(type)?.delete(listener)) {
        removed.push(type);
      }
    },
    /** Every `addEventListener` call so far, by event type. */
    added,
    /** Every `removeEventListener` call that removed a listener, by event type. */
    removed,
    listenerCount: (): number => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    /** Send an event to whoever is listening for its type. */
    dispatch(type: string, event: unknown = {}): void {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event);
      }
    },
  };
}

export type RecordingTarget = ReturnType<typeof createRecordingTarget>;
