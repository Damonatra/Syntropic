"""Agent 6 — AST-based tenant isolation veto gate.

In enterprise B2B deployments an accidental cross-tenant read is catastrophic.
This module enforces tenant isolation on every decorated database or vector
store operation:

1. Fail-closed tenant resolution: a call without a bound tenant context (and
   without an explicit ``tenant_id`` argument) is vetoed *before* dispatch.
2. Automatic tenant injection: the resolved tenant is injected as the
   ``tenant_id`` keyword argument so the wrapped function MUST filter on it.
3. Structural query inspection: raw SQL is parsed with sqlglot so
   ``tenant_id`` must appear as an actual column reference — mentions inside
   comments, string literals, or misnamed columns (``tenant_id_hint``) are
   rejected. Qdrant filter payloads are walked recursively, and Python
   expression strings are inspected with the stdlib :mod:`ast` visitor.
"""

import ast
import asyncio
import inspect
import logging
import sqlglot
from sqlglot import expressions as exp
from collections.abc import Mapping
from contextlib import contextmanager
from contextvars import ContextVar, Token
from functools import wraps
from typing import Any, Callable, Iterator

logger = logging.getLogger("syntropic.security.ast_veto")

VETO_MESSAGE = (
    "Security Veto Triggered: Query missing mandatory 'tenant_id' isolation filter."
)
NO_TENANT_MESSAGE = (
    "Security Veto Triggered: no tenant_id context is bound; refusing to execute."
)

TENANT_ID_COLUMN = "tenant_id"

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


# ---------------------------------------------------------------------------
# Structural inspection
# ---------------------------------------------------------------------------

class TenantIsolationVisitor(ast.NodeVisitor):
    """AST Visitor that checks for the presence of 'tenant_id' in Python expressions."""

    def __init__(self):
        self.has_tenant_filter = False

    @staticmethod
    def _mentions_tenant(value: Any) -> bool:
        return isinstance(value, str) and TENANT_ID_COLUMN in value.lower()

    def visit_Compare(self, node: ast.Compare):
        # Look for comparisons involving 'tenant_id'
        for target in [node.left] + node.comparators:
            if isinstance(target, ast.Name) and TENANT_ID_COLUMN in target.id.lower():
                self.has_tenant_filter = True
            elif isinstance(target, ast.Attribute) and TENANT_ID_COLUMN in target.attr.lower():
                self.has_tenant_filter = True
            elif isinstance(target, ast.Subscript) and self._mentions_tenant(
                target.slice.value if isinstance(target.slice, ast.Constant) else None
            ):
                self.has_tenant_filter = True
            elif isinstance(target, ast.Constant) and isinstance(target.value, str) and TENANT_ID_COLUMN in target.value.lower():
                self.has_tenant_filter = True
        self.generic_visit(node)

    def visit_Keyword(self, node: ast.keyword):
        if node.arg and TENANT_ID_COLUMN in node.arg.lower():
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


def _sql_has_tenant_filter(query_text: str) -> bool:
    """Require ``tenant_id`` as a real column reference in parsed SQL.

    sqlglot strips comments during parsing, so a ``tenant_id`` mention that
    lives only in a comment never becomes a column node. Misnamed columns
    such as ``tenant_id_hint`` do not match. Parse failures fail closed.
    """
    if TENANT_ID_COLUMN not in query_text.lower():
        return False
    try:
        parsed = sqlglot.parse_one(query_text, read="postgres")
    except (sqlglot.errors.ParseError, ValueError):
        # Fail closed: unparseable SQL can never prove tenant isolation.
        return False

    for node in parsed.find_all(exp.Column):
        if node.name and node.name.lower() == TENANT_ID_COLUMN:
            return True
    for node in parsed.find_all(exp.Parameter):
        name = getattr(getattr(node, "this", None), "name", "")
        if name and name.lower() == TENANT_ID_COLUMN:
            return True
    return False


def _filter_dict_has_tenant(payload: Any) -> bool:
    """Recursively walk Qdrant-style filter payloads looking for tenant scope."""
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            if isinstance(key, str) and key.lower() == TENANT_ID_COLUMN:
                return True
            if isinstance(value, str) and value.lower() == TENANT_ID_COLUMN:
                # Qdrant FieldCondition payloads: {"key": "tenant_id", ...}
                return True
            if _filter_dict_has_tenant(value):
                return True
        return False
    if isinstance(payload, (list, tuple)):
        return any(_filter_dict_has_tenant(item) for item in payload)
    return False


def _stringify_query(query: Any) -> str:
    """Render a query argument (raw SQL text or filter mapping) as inspectable text."""
    if isinstance(query, str):
        return query
    if isinstance(query, Mapping):
        return str(dict(query))
    return str(query)


def verify_query_safety(query: Any) -> bool:
    """
    Structurally verifies tenant isolation for SQL text, filter mappings,
    or Python expression strings.

    Returns ``False`` whenever no ``tenant_id`` filter can be established in
    the query structure (fail closed): comments, string literals, and
    misnamed columns do not count.
    """
    if isinstance(query, Mapping):
        return _filter_dict_has_tenant(query)

    query_text = _stringify_query(query)

    # Python expressions (ORM fragments, Qdrant payload reprs) inspect via ast.
    try:
        tree = ast.parse(query_text)
    except (SyntaxError, ValueError):
        tree = None
    if tree is not None:
        visitor = TenantIsolationVisitor()
        visitor.visit(tree)
        return visitor.has_tenant_filter

    # Raw SQL: sqlglot structural parse (comments stripped, columns required).
    return _sql_has_tenant_filter(query_text)


def verify_query_has_tenant_isolation(query_string: Any) -> bool:
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


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

_QUERY_KWARG_NAMES = ("query", "sql", "query_filter")


def _find_query_candidate(args: tuple, kwargs: dict) -> Any:
    """Locate the query-like argument a call is attempting to dispatch."""
    for name in _QUERY_KWARG_NAMES:
        if name in kwargs:
            return kwargs[name]
    if args and isinstance(args[0], (str, Mapping)):
        return args[0]
    return None


def _resolve_tenant_or_raise(
    func: Callable[..., Any],
    accepts_tenant_kwarg: bool,
    args: tuple,
    kwargs: dict,
) -> str:
    """Resolve the tenant for this call or veto it (fail closed)."""
    tenant_id = None
    if accepts_tenant_kwarg and isinstance(kwargs.get("tenant_id"), str):
        tenant_id = kwargs["tenant_id"]
    if not tenant_id:
        tenant_id = get_current_tenant()
    if not tenant_id:
        query_candidate = _find_query_candidate(args, kwargs)
        logger.critical(
            "[SECURITY VETO] Blocked tenant-less execution of %s: no tenant "
            "context is bound and no explicit tenant_id was provided "
            "(query=%s).",
            getattr(func, "__name__", repr(func)),
            _stringify_query(query_candidate) if query_candidate is not None else "<none>",
        )
        raise TenantIsolationViolationError(NO_TENANT_MESSAGE)
    return tenant_id


def _prepare_isolated_call(
    func: Callable[..., Any],
    accepts_tenant_kwarg: bool,
    args: tuple,
    kwargs: dict,
) -> tuple:
    """Shared guard: resolve tenant, inspect queries, inject the tenant kwarg."""
    tenant_id = _resolve_tenant_or_raise(func, accepts_tenant_kwarg, args, kwargs)

    query_candidate = _find_query_candidate(args, kwargs)
    if query_candidate is not None and not verify_query_safety(query_candidate):
        logger.critical(
            "[SECURITY VETO] Blocked unsegmented query: %s (operation=%s, tenant_context=%s)",
            _stringify_query(query_candidate),
            getattr(func, "__name__", repr(func)),
            tenant_id,
        )
        raise TenantIsolationViolationError(VETO_MESSAGE)

    if accepts_tenant_kwarg:
        kwargs.setdefault("tenant_id", tenant_id)
    return args, kwargs


def enforce_tenant_isolation(func: Callable[..., Any]) -> Callable[..., Any]:
    """
    Decorator that vetoes any database or vector operation lacking tenant isolation.

    The decorator resolves the tenant bound to the active request context (or
    an explicit ``tenant_id`` keyword argument), fails closed when neither is
    available, structurally inspects any query argument, and automatically
    injects the resolved tenant so the wrapped function filters on it. Both
    coroutine and synchronous functions are supported.
    """
    signature = inspect.signature(func)
    accepts_tenant_kwarg = "tenant_id" in signature.parameters

    if asyncio.iscoroutinefunction(func):

        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            _prepare_isolated_call(func, accepts_tenant_kwarg, args, kwargs)
            return await func(*args, **kwargs)

        return async_wrapper

    @wraps(func)
    def sync_wrapper(*args, **kwargs):
        _prepare_isolated_call(func, accepts_tenant_kwarg, args, kwargs)
        return func(*args, **kwargs)

    return sync_wrapper
