"""Layer 5 — Commercial instrumentation & revenue-share proof.

The ROI value ledger (queryable projection of the Taelin
``margin_adjusted`` events) plus the deterministic reporting surfaces that
make the deployment's revenue-share contract measurable:

* ``reporting.roi_summary`` — cumulative value captured per tenant with
  payback progress against the deployment cost.
* ``reporting.monthly_statement`` — the contractual revenue-share
  statement, hashed over its canonical JSON so both parties can verify
  that a signed statement was computed from unmutated data.

Money math is currency-scoped end to end: per-ISO-code buckets are the
unit of account, and mixed-currency totals are never silently summed.
"""
