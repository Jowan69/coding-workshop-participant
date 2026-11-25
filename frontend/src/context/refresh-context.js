import { createContext, useContext } from 'react';

const NO_REFRESH = { refreshKey: 0, onLoaded: undefined };

/**
 * A page-wide refresh signal: `refreshKey` changes when the page wants fresh data and
 * `onLoaded` is called by each section when a response arrives. Provided by the Dashboard.
 */
export const RefreshContext = createContext(NO_REFRESH);

/**
 * The refresh signal for useApiGet's options; without a provider nothing ever refreshes.
 *
 * @returns {{refreshKey: number, onLoaded: (() => void)|undefined}} The signal.
 */
export function useRefresh() {
  return useContext(RefreshContext);
}
