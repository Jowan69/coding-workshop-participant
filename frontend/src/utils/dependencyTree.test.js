import { describe, expect, it } from 'vitest';
import { chainRows } from './dependencyTree';

function item(id, depth, dependsOn = [], due = '2026-12-01') {
  return { id, title: `D${id}`, due_date: due, depth, depends_on_ids: dependsOn };
}

const titlesWithLevels = (rows) => rows.map(({ item: row, level }) => `${level}:${row.title}`);

describe('chainRows', () => {
  it('nests a three-link chain under its root and keeps a lone deliverable at the top', () => {
    // As /insights/dependencies returns them: shallowest first
    const rows = chainRows([
      item(1, 0), item(5, 0, [], '2026-12-09'), item(2, 1, [1]), item(3, 2, [2]), item(4, 3, [3]),
    ]);
    expect(titlesWithLevels(rows)).toEqual(['0:D1', '1:D2', '2:D3', '3:D4', '0:D5']);
  });

  it('shows a deliverable with two parents once, under the earliest-due parent one level up', () => {
    const rows = chainRows([
      item(1, 0),
      item(3, 1, [1], '2026-12-02'),
      item(2, 1, [1], '2026-12-05'),
      item(4, 2, [2, 3]),
    ]);
    expect(titlesWithLevels(rows)).toEqual(['0:D1', '1:D3', '2:D4', '1:D2']);
  });

  it('ignores a direct dependency that is not one level up', () => {
    // D3 depends on D1 (depth 0) and D2 (depth 1); only D2 is one level up.
    const rows = chainRows([item(1, 0), item(2, 1, [1]), item(3, 2, [1, 2])]);
    expect(titlesWithLevels(rows)).toEqual(['0:D1', '1:D2', '2:D3']);
  });

  it('never loops on a cycle from bad data and still lists every deliverable once', () => {
    // 1 -> 3 -> 2 -> 1 is a cycle; 4 depends on 3. Depths as the API computes them.
    const rows = chainRows([item(1, 2, [3]), item(2, 2, [1]), item(3, 2, [2]), item(4, 3, [3])]);
    expect(titlesWithLevels(rows)).toEqual(['0:D1', '0:D2', '0:D3', '1:D4']);
  });

  it('returns nothing for a project without deliverables', () => {
    expect(chainRows([])).toEqual([]);
  });
});
