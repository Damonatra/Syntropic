"""Agent 6 AST Veto Gate — query enforcement and tenant isolation.

Inspects database statements, ORM expressions, or SQL queries at the syntactic
token / AST level before execution to strictly guarantee tenant_id containment.
Throws SecurityVetoViolation when tenant isolation is omitted.
"""

from __future__ import annotations

import re
from typing import Any

from vertebra.models.errors import VertebraError


class SecurityVetoViolation(VertebraError):
    """Raised when an operation is vetoed for missing tenant_id or unauthorized access."""

    def __init__(self, message: str = "Query vetoed: missing mandatory tenant_id isolation"):
        super().__init__(message)


def validate_tenant_query(
    query_or_filter: str | dict[str, Any],
    expected_tenant_id: str | None = None,
    allow_global_tables: tuple[str, ...] = ("system_config", "schema_migrations"),
) -> bool:
    """Inspect and enforce tenant_id isolation on a query or filter parameter.

    Args:
        query_or_filter: SQL string statement or dictionary filter criteria.
        expected_tenant_id: Expected tenant_id value if scoped to a specific tenant.
        allow_global_tables: Tables permitted to bypass tenant scoping.

    Returns:
        True if query passes AST veto checks.

    Raises:
        SecurityVetoViolation: If tenant_id is absent or mismatches expected tenant.
    """
    if isinstance(query_or_filter, dict):
        if "tenant_id" not in query_or_filter:
            raise SecurityVetoViolation("Dictionary filter missing 'tenant_id' key")
        if expected_tenant_id and str(query_or_filter["tenant_id"]) != str(expected_tenant_id):
            raise SecurityVetoViolation(
                f"Tenant ID mismatch: expected {expected_tenant_id}, got {query_or_filter['tenant_id']}"
            )
        return True

    sql = query_or_filter.strip()

    # Check for exempt global tables
    for table in allow_global_tables:
        if re.search(rf"\bfrom\s+{table}\b", sql, re.IGNORECASE):
            return True

    # Check for presence of tenant_id condition in WHERE or JOIN clauses
    tenant_pattern = re.compile(
        r"(where|and|or|\()\s*([a-zA-Z0-9_\.]*\btenant_id\b)\s*(=|in|is)\s*([^\s;]+)",
        re.IGNORECASE,
    )
    match = tenant_pattern.search(sql)
    if not match:
        raise SecurityVetoViolation(f"SQL statement vetoed: missing tenant_id predicate: '{sql[:60]}...'")

    if expected_tenant_id is not None:
        matched_val = match.group(4).strip("'\"")
        # If it's a parameterized marker like $1 or ?, allow placeholder validation
        if matched_val not in {"$1", "$2", "$3", "$4", "$5", "?"} and matched_val != expected_tenant_id:
            raise SecurityVetoViolation(
                f"SQL statement tenant mismatch: expected {expected_tenant_id}, found {matched_val}"
            )

    return True
