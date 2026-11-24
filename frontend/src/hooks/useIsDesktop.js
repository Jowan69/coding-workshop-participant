import { useMediaQuery } from 'react-responsive';

/** Width at which the layout switches from phone to desktop. */
export const DESKTOP_MIN_WIDTH = 900;

/**
 * Whether the viewport is desktop-sized (900px and wider).
 *
 * @returns {boolean} True on desktop, false on phones and small tablets.
 */
export function useIsDesktop() {
  return useMediaQuery({ minWidth: DESKTOP_MIN_WIDTH });
}
