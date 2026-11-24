function byDueDateThenId(a, b) {
  if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  return a.id - b.id;
}

/**
 * Order a project's dependency chain for an indented list: every deliverable exactly once,
 * directly under the deliverable it hangs from and one level deeper.
 *
 * A deliverable hangs from the direct dependency one level up (depth − 1), the earliest due
 * when there are several. Parents are always exactly one level shallower, so the tree can
 * never loop. A deliverable without such a parent is shown at the top level; with valid data
 * that only happens at depth 0, and with bad data it can happen inside a cycle.
 *
 * @param {Array<{id: number, due_date: string, depth: number, depends_on_ids: number[]}>} items
 *   Deliverables from /insights/dependencies, shallowest first.
 * @returns {Array<{item: object, level: number}>} Rows in display order with their indent.
 */
export function chainRows(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map();
  const roots = [];
  items.forEach((item) => {
    const [parent] = (item.depends_on_ids ?? [])
      .map((id) => byId.get(id))
      .filter((candidate) => candidate && candidate.depth === item.depth - 1)
      .sort(byDueDateThenId);
    if (parent) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), item]);
    } else {
      roots.push(item);
    }
  });

  const rows = [];
  const visit = (item, level) => {
    rows.push({ item, level });
    (children.get(item.id) ?? []).forEach((child) => visit(child, level + 1));
  };
  roots.forEach((root) => visit(root, 0));
  return rows;
}
