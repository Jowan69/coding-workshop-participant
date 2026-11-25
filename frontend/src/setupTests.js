import '@testing-library/jest-dom/vitest';
import { cleanup, configure, getConfig } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Let React finish before a test continues after `findBy*`, `waitFor` or a user-event call.
 *
 * Testing Library ends each of those with one zero-delay timeout, but React schedules its
 * renders with setImmediate. Node gives no order between the two, so on a busy machine a test
 * could resume while a response that had already resolved was still unrendered (a list's
 * loading skeleton instead of its rows). Yielding a few real event-loop turns first makes the
 * order fixed: effects, then the render of what they loaded.
 */
const realSetImmediate = globalThis.setImmediate;
const SETTLE_TURNS = 4;
const libraryAsyncWrapper = getConfig().asyncWrapper;

configure({
  asyncWrapper: (callback) => libraryAsyncWrapper(async () => {
    const result = await callback();
    for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
      await new Promise((resolve) => { realSetImmediate(resolve); });
    }
    return result;
  }),
});

/**
 * jsdom has no matchMedia. This mock answers width queries against window.innerWidth
 * (1024 by default), so a test can switch to a phone layout by setting innerWidth first.
 */
function matches(query) {
  const width = window.innerWidth;
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn((query) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.innerWidth = 1024;
});
