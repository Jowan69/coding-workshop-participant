import { useEffect, useState } from 'react';

/**
 * The value, once it has stopped changing for `delay` ms. An empty string passes through at
 * once, so clearing a search box reloads immediately.
 *
 * @template T
 * @param {T} value Fast-changing value, e.g. a search box.
 * @param {number} [delay] Quiet period in milliseconds.
 * @returns {T} The debounced value.
 */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return value === '' ? value : debounced;
}
