"""Zero-UI Outlook draft dispatch (Layer 4 Vector 1).

Submodules:
- ``graph_auth``: Azure AD client-credentials token management (cache +
  silent background renewal, zero user interaction).
- ``draft_composer``: pure, deterministic approved-RFQ -> Outlook draft
  renderer (HTML/MIME-safe, escaped, margin-defense annotated).
- ``outlook_dispatch``: durable Drafts-folder-only injection worker backed
  by the ``dispatch_outbox`` table (lease-claim, exponential backoff,
  Backbone escalation for unrecoverable failures).

HARD INVARIANT: no code path in this package can send mail. The only
Microsoft Graph write endpoint used is
``POST /users/{mailbox}/mailFolders/Drafts/messages`` — drafts stay in the
estimator's Drafts folder until a human clicks Send (HITL liability
boundary). A contract test enforces this permanently.
"""
