import { describe, expect, it } from 'vitest';
import { createFakePage } from '../testing/fake-page';
import { createRecordingTarget } from '../testing/recording-target';
import {
  createFullScreen,
  fitPlayfield,
  playRegionHeight,
  prefersReducedMotion,
  trackPlayRegion,
  unlockSoundOnFirstGesture,
  watchForTouch,
  type FullScreenApi,
} from './page';

/** The game's playfield in its own pixels: the canvas the board and the HUD are drawn on. */
const PLAYFIELD = { width: 992, height: 576 };

describe('playRegionHeight', () => {
  it('is the viewport less the host scroll margin', () => {
    expect(playRegionHeight(800, 56)).toBe(744);
    expect(playRegionHeight(800, 0)).toBe(800);
  });

  it('is never negative', () => {
    expect(playRegionHeight(40, 56)).toBe(0);
  });
});

describe('fitPlayfield', () => {
  it('fills the width of a 390 by 700 region with 160 reserved, at the shape of the playfield', () => {
    const fitted = fitPlayfield({ width: 390, height: 700 }, PLAYFIELD, 160);
    expect(fitted.cssWidth).toBe(390);
    expect(fitted.cssWidth / fitted.cssHeight).toBeCloseTo(992 / 576, 9);
  });

  it('is limited by the height when the region is wide and short', () => {
    const fitted = fitPlayfield({ width: 844, height: 334 }, PLAYFIELD, 62);
    expect(fitted.cssHeight).toBe(272);
    expect(fitted.cssWidth).toBeCloseTo((272 * 992) / 576, 9);
    expect(fitted.cssWidth / fitted.cssHeight).toBeCloseTo(992 / 576, 9);
  });

  it('grows past the size of the playfield on a large screen', () => {
    const fitted = fitPlayfield({ width: 2560, height: 1300 }, PLAYFIELD, 100);
    expect(fitted.cssWidth).toBeGreaterThan(PLAYFIELD.width);
  });

  it('never exceeds the region in either direction, nor what the reserved height leaves', () => {
    for (let width = 0; width <= 2600; width += 97) {
      for (let height = 0; height <= 1500; height += 83) {
        for (const reservedHeight of [0, 48, 160, 2000]) {
          const fitted = fitPlayfield({ width, height }, PLAYFIELD, reservedHeight);
          expect(fitted.cssWidth).toBeGreaterThanOrEqual(0);
          expect(fitted.cssHeight).toBeGreaterThanOrEqual(0);
          expect(fitted.cssWidth).toBeLessThanOrEqual(width);
          expect(fitted.cssHeight).toBeLessThanOrEqual(Math.max(height - reservedHeight, 0));
        }
      }
    }
  });
});

describe('trackPlayRegion', () => {
  function setUp(options: { scrollMarginTop?: string } = {}) {
    const { document, hostElement } = createFakePage();
    if (options.scrollMarginTop !== undefined) {
      hostElement.style.scrollMarginTop = options.scrollMarginTop;
    }
    const root = document.createElement('div');
    hostElement.append(root);
    const windowListeners = createRecordingTarget();
    const state = { innerHeight: 800, fullScreen: false };
    const heights: number[] = [];
    const region = trackPlayRegion({
      hostElement,
      root,
      view: {
        get innerHeight() {
          return state.innerHeight;
        },
        getComputedStyle: (element: Element) => document.defaultView!.getComputedStyle(element),
        addEventListener: windowListeners.addEventListener,
        removeEventListener: windowListeners.removeEventListener,
      } as unknown as Parameters<typeof trackPlayRegion>[0]['view'],
      isFullScreen: () => state.fullScreen,
      onChange: (height) => heights.push(height),
    });
    const written = (): string => root.style.getPropertyValue('--play-region-height');
    return { region, state, heights, windowListeners, written, hostElement, root };
  }

  it('writes the viewport height less the host scroll margin to a CSS variable on the game root, at once', () => {
    const { region, heights, written, hostElement } = setUp({ scrollMarginTop: '56px' });
    expect(written()).toBe('744px');
    expect(region.height()).toBe(744);
    expect(heights).toEqual([744]);
    // Only the game's own root is written to.
    expect(hostElement.style.getPropertyValue('--play-region-height')).toBe('');
  });

  it('uses the whole viewport when the host sets no scroll margin', () => {
    expect(setUp().written()).toBe('800px');
  });

  it('measures again on resize, and tells only of a height that changed', () => {
    const { state, heights, windowListeners, written } = setUp({ scrollMarginTop: '56px' });
    state.innerHeight = 400;
    windowListeners.dispatch('resize');
    expect(written()).toBe('344px');
    windowListeners.dispatch('resize');
    expect(heights).toEqual([744, 344]);
  });

  it('leaves out the scroll margin while full screen, when the host chrome is not on the screen', () => {
    const { region, state, written } = setUp({ scrollMarginTop: '56px' });
    state.fullScreen = true;
    region.measure();
    expect(written()).toBe('800px');
  });

  it('stops listening on dispose', () => {
    const { region, state, windowListeners, written } = setUp();
    region.dispose();
    expect(windowListeners.listenerCount()).toBe(0);
    state.innerHeight = 300;
    windowListeners.dispatch('resize');
    expect(written()).toBe('800px');
  });
});

describe('createFullScreen', () => {
  function setUp() {
    const { document, hostElement: element } = createFakePage();
    const changeTarget = createRecordingTarget();
    const record = { current: null as HTMLElement | null, exitCalls: 0, refuse: false };
    const change = (next: HTMLElement | null): Promise<void> => {
      if (record.refuse) {
        return Promise.reject(new Error('refused'));
      }
      record.current = next;
      changeTarget.dispatch('fullscreenchange');
      return Promise.resolve();
    };
    const api: FullScreenApi = {
      isSupported: () => true,
      isFullScreen: (asked) => record.current === asked,
      request: (asked) => change(asked),
      exit: () => {
        record.exitCalls += 1;
        return change(null);
      },
    };
    const changes: boolean[] = [];
    const fullScreen = createFullScreen({
      element,
      api,
      changeTarget: changeTarget as unknown as Document,
      onChange: (active) => changes.push(active),
    });
    return { document, element, changeTarget, record, changes, fullScreen };
  }

  it('toggle enters full screen with its element, then leaves it, and reports each change', () => {
    const { element, record, changes, fullScreen } = setUp();
    expect(fullScreen.isActive()).toBe(false);
    fullScreen.toggle();
    expect(record.current).toBe(element);
    expect(fullScreen.isActive()).toBe(true);
    fullScreen.toggle();
    expect(record.current).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it('reports a change the browser made itself, such as Escape', () => {
    const { changeTarget, record, changes, fullScreen } = setUp();
    fullScreen.toggle();
    record.current = null;
    changeTarget.dispatch('fullscreenchange');
    expect(changes).toEqual([true, false]);
  });

  it('is not active while some other element is full screen', () => {
    const { document, record, fullScreen } = setUp();
    record.current = document.createElement('video');
    expect(fullScreen.isActive()).toBe(false);
  });

  it('changes nothing when the browser refuses', async () => {
    const { record, changes, fullScreen } = setUp();
    record.refuse = true;
    fullScreen.toggle();
    await Promise.resolve();
    expect(fullScreen.isActive()).toBe(false);
    expect(changes).toEqual([]);
  });

  it('on dispose stops listening and leaves full screen if its element was in it', () => {
    const { changeTarget, record, changes, fullScreen } = setUp();
    fullScreen.toggle();
    fullScreen.dispose();
    expect(record.exitCalls).toBe(1);
    expect(record.current).toBeNull();
    expect(changeTarget.listenerCount()).toBe(0);
    // The exit on the way out is not reported: nobody is listening any more.
    expect(changes).toEqual([true]);
  });

  it('on dispose leaves full screen alone when its element was not in it', () => {
    const { document, record, fullScreen } = setUp();
    record.current = document.createElement('video');
    fullScreen.dispose();
    expect(record.exitCalls).toBe(0);
    expect(record.current).not.toBeNull();
  });
});

describe('watchForTouch', () => {
  function setUp(pointerIsCoarse: boolean) {
    const windowListeners = createRecordingTarget();
    const query = createRecordingTarget();
    const media = { matches: pointerIsCoarse };
    const queriesAsked: string[] = [];
    let reports = 0;
    const watch = watchForTouch({
      view: {
        matchMedia: (text: string) => {
          queriesAsked.push(text);
          return {
            get matches() {
              return media.matches;
            },
            addEventListener: query.addEventListener,
            removeEventListener: query.removeEventListener,
          };
        },
        addEventListener: windowListeners.addEventListener,
        removeEventListener: windowListeners.removeEventListener,
      } as unknown as Parameters<typeof watchForTouch>[0]['view'],
      onTouch: () => {
        reports += 1;
      },
    });
    return { watch, windowListeners, query, media, queriesAsked, reports: () => reports };
  }

  it('reports at once when the main pointer is coarse', () => {
    const { reports, queriesAsked } = setUp(true);
    expect(queriesAsked).toEqual(['(pointer: coarse)']);
    expect(reports()).toBe(1);
  });

  it('with a fine pointer reports on the first touch, and only once', () => {
    const { windowListeners, reports } = setUp(false);
    expect(reports()).toBe(0);
    windowListeners.dispatch('touchstart');
    windowListeners.dispatch('touchstart');
    expect(reports()).toBe(1);
  });

  it('reports when the device changes to a coarse pointer, and not when it changes away from one', () => {
    const { query, media, reports } = setUp(false);
    query.dispatch('change');
    expect(reports()).toBe(0);
    media.matches = true;
    query.dispatch('change');
    expect(reports()).toBe(1);
  });

  it('stops listening to the window and to the media query on dispose', () => {
    const { watch, windowListeners, query, reports } = setUp(false);
    expect(windowListeners.added).toEqual(['touchstart']);
    expect(query.added).toEqual(['change']);
    watch.dispose();
    expect(windowListeners.listenerCount()).toBe(0);
    expect(query.listenerCount()).toBe(0);
    windowListeners.dispatch('touchstart');
    expect(reports()).toBe(0);
  });
});

describe('prefersReducedMotion', () => {
  /** A window whose visitor has, or has not, asked for less motion. */
  function viewWhere(reducedMotionIsOn: boolean) {
    const queriesAsked: string[] = [];
    const view = {
      matchMedia: (text: string) => {
        queriesAsked.push(text);
        return { matches: reducedMotionIsOn && text === '(prefers-reduced-motion: reduce)' };
      },
    } as unknown as Pick<Window, 'matchMedia'>;
    return { view, queriesAsked };
  }

  it('is true when the visitor has asked their device for less motion', () => {
    const { view, queriesAsked } = viewWhere(true);
    expect(prefersReducedMotion(view)).toBe(true);
    expect(queriesAsked).toEqual(['(prefers-reduced-motion: reduce)']);
  });

  it('is false when they have not', () => {
    expect(prefersReducedMotion(viewWhere(false).view)).toBe(false);
  });
});

describe('unlockSoundOnFirstGesture', () => {
  function setUp(options: { resumes?: boolean; isKeyInsideGame?: () => boolean } = {}) {
    const keyTarget = createRecordingTarget();
    const pointerTarget = createRecordingTarget();
    const contexts: Array<{ state: AudioContextState; resumeCalls: number; closeCalls: number }> = [];
    const unlockedWith: unknown[] = [];
    const unlock = unlockSoundOnFirstGesture({
      keyTarget: keyTarget as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
      pointerTarget: pointerTarget as unknown as Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
      isKeyInsideGame: options.isKeyInsideGame ?? (() => true),
      createContext() {
        const context = {
          state: 'suspended' as AudioContextState,
          resumeCalls: 0,
          closeCalls: 0,
          resume() {
            context.resumeCalls += 1;
            if (options.resumes === false) {
              return Promise.reject(new Error('refused'));
            }
            context.state = 'running';
            return Promise.resolve();
          },
          close() {
            context.closeCalls += 1;
            return Promise.resolve();
          },
        };
        contexts.push(context);
        return context;
      },
      onUnlock: (context) => unlockedWith.push(context),
    });
    return { keyTarget, pointerTarget, contexts, unlockedWith, unlock };
  }

  it('makes no context until a gesture; the first key makes one, resumes it and hands it over; later gestures make none', () => {
    const { keyTarget, pointerTarget, contexts, unlockedWith } = setUp();
    expect(contexts).toEqual([]);

    keyTarget.dispatch('keydown');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ state: 'running', resumeCalls: 1 });
    expect(unlockedWith).toEqual([contexts[0]]);

    keyTarget.dispatch('keydown');
    pointerTarget.dispatch('pointerdown');
    pointerTarget.dispatch('pointerup');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resumeCalls).toBe(1);
    expect(unlockedWith).toHaveLength(1);
  });

  it('a pointer going down or coming up, a finger lifting, or a click on the game is a first gesture too', () => {
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'click']) {
      const { pointerTarget, contexts } = setUp();
      pointerTarget.dispatch(type);
      expect(contexts).toHaveLength(1);
      expect(contexts[0].resumeCalls).toBe(1);
    }
  });

  it('a key the game says is not its own makes no context', () => {
    let inside = false;
    const { keyTarget, contexts } = setUp({ isKeyInsideGame: () => inside });
    keyTarget.dispatch('keydown');
    expect(contexts).toEqual([]);
    inside = true;
    keyTarget.dispatch('keydown');
    expect(contexts).toHaveLength(1);
  });

  // Safari on an iPhone refuses a resume on a finger going down, and allows it as the finger lifts.
  it('asks a context the browser would not start to resume again on each later gesture, and makes no second one', async () => {
    const { keyTarget, pointerTarget, contexts, unlockedWith } = setUp({ resumes: false });
    pointerTarget.dispatch('pointerdown');
    pointerTarget.dispatch('pointerup');
    pointerTarget.dispatch('touchend');
    pointerTarget.dispatch('click');
    keyTarget.dispatch('keydown');
    // The refusals are swallowed: nothing is left rejected and unhandled.
    await Promise.resolve();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resumeCalls).toBe(5);
    expect(unlockedWith).toHaveLength(1);
  });

  it('dispose closes an opened context exactly once and stops listening', () => {
    const { keyTarget, pointerTarget, contexts, unlock } = setUp();
    keyTarget.dispatch('keydown');
    unlock.dispose();
    unlock.dispose();
    expect(contexts[0].closeCalls).toBe(1);
    expect(keyTarget.listenerCount()).toBe(0);
    expect(pointerTarget.listenerCount()).toBe(0);
    expect(keyTarget.removed).toEqual(keyTarget.added);
    expect(pointerTarget.removed.slice().sort()).toEqual(pointerTarget.added.slice().sort());

    keyTarget.dispatch('keydown');
    expect(contexts).toHaveLength(1);
  });

  it('dispose with no context opened closes nothing and does not throw', () => {
    const { keyTarget, pointerTarget, contexts, unlock } = setUp();
    expect(() => unlock.dispose()).not.toThrow();
    expect(contexts).toEqual([]);
    expect(keyTarget.listenerCount()).toBe(0);
    expect(pointerTarget.listenerCount()).toBe(0);
  });
});
