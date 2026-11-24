"""The API's domains; build_router() wires every domain's routes into one Router."""

from __future__ import annotations

from acme.core.http import Router
from acme.domains import allocations, auth, budgets, deliverables, projects, resources


def build_router() -> Router:
    """Return a Router holding every route of the tracker API."""
    router = Router()
    for domain in (auth, projects, deliverables, resources, allocations, budgets):
        domain.register_routes(router)
    return router
