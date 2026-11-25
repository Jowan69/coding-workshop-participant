import { afterEach, describe, expect, it } from 'vitest';
import { hashUrlFor, redirectPathToHash } from './pathRedirect';

const at = (pathname, search = '', hash = '') => ({ pathname, search, hash });

describe('non-hash URLs become hash routes (phase 6, G3)', () => {
  it.each([
    [at('/projects/5'), '/#/projects/5'],
    [at('/projects'), '/#/projects'],
    [at('/projects/5', '?tab=team&page=2'), '/#/projects/5?tab=team&page=2'],
    [at('/users/'), '/#/users/'],
    [at('/projects', '', '#'), '/#/projects'],
  ])('%o -> %s', (location, expected) => {
    expect(hashUrlFor(location)).toBe(expected);
  });

  it.each([
    ['the root', at('/')],
    ['the root with a query', at('/', '?x=1')],
    ['index.html', at('/index.html')],
    ['a file', at('/favicon.svg')],
    ['a URL that already has a hash route', at('/projects', '', '#/resources')],
    ['an empty path', at('')],
  ])('leaves %s alone', (_name, location) => {
    expect(hashUrlFor(location)).toBeNull();
  });

  describe('in the browser', () => {
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('rewrites the address in place, with no extra history entry', () => {
      window.history.replaceState(null, '', '/projects/5?tab=budget');
      const entries = window.history.length;

      expect(redirectPathToHash()).toBe('/#/projects/5?tab=budget');

      expect(window.location.pathname).toBe('/');
      expect(window.location.hash).toBe('#/projects/5?tab=budget');
      expect(window.history.length).toBe(entries);
    });

    it('does nothing on the root or on a hash route', () => {
      expect(redirectPathToHash()).toBeNull();
      window.history.replaceState(null, '', '/#/projects');
      expect(redirectPathToHash()).toBeNull();
      expect(window.location.hash).toBe('#/projects');
    });
  });
});
