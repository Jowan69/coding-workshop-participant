import { describe, expect, it } from 'vitest';
import { nextSort, parseSort, sortOptions } from './sorting';

describe('sorting helpers', () => {
  it('splits a sort value into column and direction', () => {
    expect(parseSort('end_date')).toEqual({ key: 'end_date', direction: 'asc' });
    expect(parseSort('-end_date')).toEqual({ key: 'end_date', direction: 'desc' });
    expect(parseSort()).toEqual({ key: '', direction: 'asc' });
  });

  it('sorts a new column ascending and flips the current one', () => {
    expect(nextSort('name', 'end_date')).toBe('end_date');
    expect(nextSort('end_date', 'end_date')).toBe('-end_date');
    expect(nextSort('-end_date', 'end_date')).toBe('end_date');
    expect(nextSort('', 'name')).toBe('name');
  });

  it('lists both directions of every sortable column', () => {
    const columns = [
      { key: 'name', label: 'Name', sortKey: 'name' },
      { key: 'department', label: 'Department' },
      { key: 'dates', label: 'Dates', sortKey: 'start_date' },
    ];
    expect(sortOptions(columns)).toEqual([
      { value: 'name', label: 'Name, ascending' },
      { value: '-name', label: 'Name, descending' },
      { value: 'start_date', label: 'Dates, ascending' },
      { value: '-start_date', label: 'Dates, descending' },
    ]);
    expect(sortOptions([])).toEqual([]);
  });
});
