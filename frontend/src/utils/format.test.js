import { describe, expect, it } from 'vitest';
import { formatCurrency, formatDate, formatPercent, parseDate } from './format';

describe('formatCurrency', () => {
  it.each([
    [125000, '$125,000'],
    [1234.5, '$1,234.50'],
    [0.1 + 0.2, '$0.30'],
    [-20000.5, '-$20,000.50'],
    [0, '$0'],
    ['42', '$42'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatCurrency(value)).toBe(expected);
  });

  it.each([null, undefined, '', 'abc'])('shows an em dash for %s', (value) => {
    expect(formatCurrency(value)).toBe('—');
  });
});

describe('dates and percentages', () => {
  it('reads API dates as local calendar days', () => {
    expect(parseDate('2026-01-31').getDate()).toBe(31);
    expect(formatDate('2026-03-04')).toBe('Mar 4, 2026');
    expect(formatDate(null)).toBe('—');
  });

  it('rounds percentages to one decimal place', () => {
    expect(formatPercent(42.46)).toBe('42.5%');
    expect(formatPercent(120)).toBe('120%');
    expect(formatPercent(null)).toBe('—');
  });
});
