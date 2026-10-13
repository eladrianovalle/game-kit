import { describe, expect, it } from 'vitest';
import { createRecordingTarget } from '../testing/recording-target';
import { createDisposer, watchVisibility } from './lifecycle';

describe('disposer', () => {
  it('runs teardowns in reverse order of registration', () => {
    const order: string[] = [];
    const disposer = createDisposer();
    disposer.add(() => order.push('first added'));
    disposer.add(() => order.push('second added'));
    disposer.dispose();
    expect(order).toEqual(['second added', 'first added']);
  });

  it('does nothing on a second dispose', () => {
    let runs = 0;
    const disposer = createDisposer();
    disposer.add(() => {
      runs += 1;
    });
    disposer.dispose();
    expect(() => disposer.dispose()).not.toThrow();
    expect(runs).toBe(1);
    expect(disposer.isDisposed()).toBe(true);
  });

  it('runs a teardown at once when it is added after dispose', () => {
    let runs = 0;
    const disposer = createDisposer();
    disposer.dispose();
    disposer.add(() => {
      runs += 1;
    });
    expect(runs).toBe(1);
  });

  it('runs every teardown even when one throws, then reports the failure', () => {
    const order: string[] = [];
    const disposer = createDisposer();
    disposer.add(() => order.push('first added'));
    disposer.add(() => {
      throw new Error('teardown failed');
    });
    expect(() => disposer.dispose()).toThrow('teardown failed');
    expect(order).toEqual(['first added']);
  });
});

describe('watchVisibility', () => {
  function setUp() {
    const listeners = createRecordingTarget();
    const document = { ...listeners, visibilityState: 'visible' as DocumentVisibilityState };
    const reports: boolean[] = [];
    const watch = watchVisibility({ document, onChange: (visible) => reports.push(visible) });
    const becomes = (state: DocumentVisibilityState): void => {
      document.visibilityState = state;
      listeners.dispatch('visibilitychange');
    };
    return { listeners, reports, watch, becomes };
  }

  it('tells when the tab is hidden and when it is shown again, and says nothing before either', () => {
    const { reports, becomes } = setUp();
    expect(reports).toEqual([]);
    becomes('hidden');
    becomes('visible');
    expect(reports).toEqual([false, true]);
  });

  it('stops listening on dispose', () => {
    const { listeners, reports, watch, becomes } = setUp();
    expect(listeners.added).toEqual(['visibilitychange']);
    watch.dispose();
    expect(listeners.listenerCount()).toBe(0);
    becomes('hidden');
    expect(reports).toEqual([]);
  });
});
