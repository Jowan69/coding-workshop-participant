"""Place every deliverable of one project in its dependency chain, in memory.

The work is linear in the deliverables and links of a valid (acyclic) project: each
deliverable is settled once, after everything it depends on, and its answer is built from
theirs. Dependencies are never enumerated path by path, which is what made dense projects
take minutes when this was a recursive SQL walk.
"""

from __future__ import annotations

from typing import Any

Row = dict[str, Any]

# Only bad data can contain a cycle (the API refuses links that close one). Deliverables in
# or downstream of a cycle have no settled order, so their longest chain is searched path by
# path, never revisiting a deliverable on the path. This caps that search for one request;
# past it the chains found so far are returned (they are valid chains, possibly not the
# longest).
CYCLE_WORK_BUDGET = 200_000


class _Budget:
    def __init__(self, steps: int) -> None:
        self.steps = steps

    def spend(self) -> bool:
        """Use one step; False once the budget is gone."""
        self.steps -= 1
        return self.steps >= 0


def _better(candidate: list[int], best: list[int] | None) -> bool:
    """Longer wins; between equals the lower ids win, so the answer is deterministic."""
    if best is None or len(candidate) > len(best):
        return True
    return len(candidate) == len(best) and candidate < best


def _settle_acyclic(
    depends_on: dict[int, list[int]],
) -> tuple[dict[int, list[int]], dict[int, set[int]]]:
    """Longest chain and everything upstream for each deliverable that is not near a cycle.

    A deliverable is settled once all it depends on is settled (a topological order), and
    its result is memoised for the deliverables that depend on it.
    """
    waiting = {node: len(deps) for node, deps in depends_on.items()}
    dependents: dict[int, list[int]] = {node: [] for node in depends_on}
    for node, deps in depends_on.items():
        for dep in deps:
            dependents[dep].append(node)
    ready = [node for node, count in waiting.items() if count == 0]
    chain: dict[int, list[int]] = {}
    upstream: dict[int, set[int]] = {}
    while ready:
        node = ready.pop()
        best: list[int] | None = None
        above: set[int] = set()
        for dep in depends_on[node]:
            above.add(dep)
            above |= upstream[dep]
            if _better(chain[dep], best):
                best = chain[dep]
        chain[node] = [node, *(best or [])]
        upstream[node] = above
        for dependent in dependents[node]:
            waiting[dependent] -= 1
            if waiting[dependent] == 0:
                ready.append(dependent)
    return chain, upstream


def _longest_simple_chain(
    start: int, depends_on: dict[int, list[int]], settled: dict[int, list[int]], budget: _Budget
) -> list[int]:
    """The longest chain upstream of a deliverable in or below a cycle.

    A depth-first walk with a cycle guard: it never steps onto a deliverable already on
    the current path. Where it reaches a settled deliverable it uses that one's memoised
    chain. Links are tried in id order, so the first chain of a given length is the one
    with the lowest ids.
    """
    best = [start]
    path = [start]
    on_path = {start}
    stack = [iter(depends_on[start])]
    while stack:
        for dep in stack[-1]:
            if dep in on_path:
                continue  # the cycle guard
            if dep in settled:
                if len(path) + len(settled[dep]) > len(best):
                    best = path + settled[dep]
                continue
            if len(path) + 1 > len(best):
                best = [*path, dep]
            if not budget.spend():
                continue
            path.append(dep)
            on_path.add(dep)
            stack.append(iter(depends_on[dep]))
            break
        else:
            stack.pop()
            on_path.discard(path.pop())
    return best


def _reachable(
    start: int, depends_on: dict[int, list[int]], settled: dict[int, set[int]]
) -> set[int]:
    """Everything upstream of a deliverable in or below a cycle (itself excluded)."""
    seen: set[int] = set()
    queue = list(depends_on[start])
    while queue:
        node = queue.pop()
        if node in seen:
            continue
        seen.add(node)
        if node in settled:
            seen |= settled[node]
        else:
            queue.extend(depends_on[node])
    seen.discard(start)
    return seen


def build_chain(deliverables: list[Row], edges: list[tuple[int, int]]) -> list[Row]:
    """Every deliverable with its depth, upstream deliverables and longest chain.

    Args:
        deliverables: One project's deliverables: ``id``, ``title``, ``status``,
            ``due_date``.
        edges: ``(deliverable_id, depends_on_id)`` links; any link that leaves the project
            is ignored.

    Returns:
        One row per deliverable, shallowest first (then by due date and id), with:
        ``depth`` (links on its longest upstream chain), ``upstream_ids`` (everything it
        depends on, directly or through others), ``blocked_by_upstream`` (one of those is
        blocked), ``chain_to_root`` (its longest chain, from itself to a deliverable that
        depends on nothing) and ``depends_on_ids`` (direct links only).
    """
    by_id = {row["id"]: row for row in deliverables}
    depends_on: dict[int, list[int]] = {node: [] for node in by_id}
    for node, dep in set(edges):
        if node in by_id and dep in by_id and node != dep:
            depends_on[node].append(dep)
    for deps in depends_on.values():
        deps.sort()

    chain, upstream = _settle_acyclic(depends_on)
    in_cycles = sorted(node for node in by_id if node not in chain)
    if in_cycles:
        budget = _Budget(CYCLE_WORK_BUDGET)
        cyclic_chain = {
            node: _longest_simple_chain(node, depends_on, chain, budget) for node in in_cycles
        }
        cyclic_upstream = {node: _reachable(node, depends_on, upstream) for node in in_cycles}
        chain.update(cyclic_chain)
        upstream.update(cyclic_upstream)

    rows = [
        {
            "id": node,
            "title": row["title"],
            "status": row["status"],
            "due_date": row["due_date"],
            "depth": len(chain[node]) - 1,
            "upstream_ids": sorted(upstream[node]),
            "blocked_by_upstream": any(by_id[up]["status"] == "blocked" for up in upstream[node]),
            "chain_to_root": chain[node],
            "depends_on_ids": depends_on[node],
        }
        for node, row in by_id.items()
    ]
    rows.sort(key=lambda row: (row["depth"], row["due_date"], row["id"]))
    return rows
