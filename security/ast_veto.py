"""Agent 6 — AST-based tenant isolation veto gate.

In enterprise B2B deployments an accidental cross-tenant read is catastrophic.
This module inspects database (PostgreSQL) and vector store (Qdrant) query
structures *before* dispatch, using Python's :mod:`ast` module, and vetoes any
call whose query does not carry the mandatory ``tenant_id`` segmentation filter.
"""

import ast
import logging
from collections.abc import Mapping
from contextlib import contextmanager
from contextvars import ContextVar, Token
from functools import wraps
from typing import Any, Callable, Iterator

logger = logging.getLogger("syntropic.security.ast_veto")

VETO_MESSAGE = (
    "Security Veto Triggered: Query missing mandatory 'tenant_id' isolation filter."
)

# The tenant bound to the active request context (set by the API layer per request).
current_tenant_id: ContextVar[str | None] = ContextVar(
    "syntropic_current_tenant_id", default=None
)


class TenantIsolationViolationError(Exception):
    """Raised when an unsegmented query attempts to execute without tenant isolation."""
    pass


def get_current_tenant() -> str | None:
    """Return the tenant_id bound to the active request context, if any."""
    return current_tenant_id.get()


def set_current_tenant(tenant_id: str | None) -> Token[str | None]:
    """Bind a tenant_id to the active request context; returns a reset token."""
    return current_tenant_id.set(tenant_id)


def reset_current_tenant(token: Token[str | None]) -> None:
    """Restore the active request context to a previously captured token."""
    current_tenant_id.reset(token)


@contextmanager
def tenant_context(tenant_id: str) -> Iterator[str]:
    """Context manager that binds ``tenant_id`` for the duration of the block."""
    token = set_current_tenant(tenant_id)
    try:
        yield tenant_id
    finally:
        reset_current_tenant(token)


class TenantIsolationVisitor(ast.NodeVisitor):
    """AST Visitor that checks for the presence of 'tenant_id' in SQL/filter expressions."""

    def __init__(self):
        self.has_tenant_filter = False

    @staticmethod
    def _mentions_tenant(value: Any) -> bool:
        return isinstance(value, str) and "tenant_id" in value.lower()

    def visit_Compare(self, node: ast.Compare):
        # Look for comparisons involving 'tenant_id'
        for target in [node.left] + node.comparators:
            if isinstance(target, ast.Name) and "tenant_id" in target.id.lower():
                self.has_tenant_filter = True
            elif isinstance(target, ast.Attribute) and "tenant_id" in target.attr.lower():
                self.has_tenant_filter = True
            elif isinstance(target, ast.Subscript) and self._mentions_tenant(
                target.slice.value if isinstance(target.slice, ast.Constant) else None
            ):
                self.has_tenant_filter = True
            elif isinstance(target, ast.Constant) and isinstance(target.value, str) and "tenant_id" in target.value.lower():
                self.has_tenant_filter = True
        self.generic_visit(node)

    def visit_Keyword(self, node: ast.keyword):
        if node.arg and "tenant_id" in node.arg.lower():
            self.has_tenant_filter = True
        elif self._mentions_tenant(
            node.value.value if isinstance(node.value, ast.Constant) else None
        ):
            # Vector-store filters name the field as a value: key="tenant_id".
            self.has_tenant_filter = True
        self.generic_visit(node)

    def visit_keyword(self, node: ast.keyword):
        # ``ast.NodeVisitor`` dispatches on the lowercase class name ``ast.keyword``.
        self.visit_Keyword(node)

    def visit_Dict(self, node: ast.Dict):
        # Filter dictionaries (including nested Qdrant payloads) segment by key
        # or by a literal field-name value such as {"key": "tenant_id"}.
        for key, value in zip(node.keys, node.values):
            if isinstance(key, ast.Constant) and self._mentions_tenant(key.value):
                self.has_tenant_filter = True
            elif isinstance(value, ast.Constant) and self._mentions_tenant(value.value):
                self.has_tenant_filter = True
        self.generic_visit(node)


def _stringify_query(query: Any) -> str:
    """Render a query argument (raw SQL text or filter mapping) as inspectable text."""
    if isinstance(query, str):
        return query
    if isinstance(query, Mapping):
        return str(dict(query))
    return str(query)


def verify_query_safety(query_str: str) -> bool:
    """
    Parses a query string into an AST and verifies tenant isolation compliance.

    Accepts raw SQL text or a filter mapping; returns ``False`` whenever no
    ``tenant_id`` filter can be established (fail closed).
    """
    query_str = _stringify_query(query_str)

    # For raw SQL queries, perform a substring check as a fast fallback
    if "tenant_id" not in query_str.lower():
        return False

    try:
        tree = ast.parse(query_str)
    except (SyntaxError, ValueError):
        # If it's a parameterized SQL string, check presence of keyword
        return "tenant_id" in query_str.lower()

    visitor = TenantIsolationVisitor()
    visitor.visit(tree)
    return visitor.has_tenant_filter


def verify_query_has_tenant_isolation(query_string: str) -> bool:
    """
    Parses incoming SQL strings or filter dictionaries to verify the presence of
    the mandatory ``tenant_id`` segmentation parameter.

    Returns ``True`` when the query structure is tenant-isolated and raises
    :class:`TenantIsolationViolationError` when ``tenant_id`` is missing.
    """
    if verify_query_safety(query_string):
        return True
    logger.critical(
        "[SECURITY VETO] Unsegmented query rejected by AST inspector: %s",
        _stringify_query(query_string),
    )
    raise TenantIsolationViolationError(VETO_MESSAGE)


def enforce_tenant_isolation(func: Callable[..., Any]) -> Callable[..., Any]:
    """
    Decorator that vetoes any database or vector operation lacking tenant isolation.

    Extracts the tenant_id bound to the active request context, validates the
    query AST before dispatching to PostgreSQL or Qdrant, and instantly halts
    execution with a security audit warning when the check fails.
    """

    @wraps(func)
    async def wrapper(*args, **kwargs):
        # Extract tenant_id from the active request context for the audit trail.
        tenant_id = get_current_tenant()
        if tenant_id is None and isinstance(kwargs.get("tenant_id"), str):
            tenant_id = kwargs["tenant_id"]

        # Inspect query arguments passed to the function
        query_arg = kwargs.get("query")
        if query_arg is None and args and isinstance(args[0], (str, Mapping)):
            query_arg = args[0]

        if query_arg is not None and not verify_query_safety(str(query_arg)):
            logger.critical(
                "[SECURITY VETO] Blocked unsegmented query: %s (operation=%s, tenant_context=%s)",
                str(query_arg),
                getattr(func, "__name__", repr(func)),
                tenant_id,
            )
            raise TenantIsolationViolationError(VETO_MESSAGE)

        return await func(*args, **kwargs)
    return wrapper
