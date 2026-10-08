"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";

type RejectReviewDialogProps = {
  disabled: boolean;
  onConfirm: () => Promise<boolean>;
};

export function RejectReviewDialog({
  disabled,
  onConfirm,
}: RejectReviewDialogProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function confirmRejection() {
    setSubmitting(true);
    try {
      if (await onConfirm()) setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="reject-button"
          type="button"
          disabled={disabled}
        >
          Reject
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Close className="dialog-close" aria-label="Close">
            <X size={17} />
          </Dialog.Close>
          <AlertTriangle className="dialog-icon" size={22} />
          <Dialog.Title className="dialog-title">Reject this RFQ?</Dialog.Title>
          <Dialog.Description className="dialog-description">
            This marks the RFQ as rejected and prevents it from proceeding to
            ERP. You can still add context in the review note.
          </Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button className="secondary-button dialog-cancel" type="button">
                Keep in review
              </button>
            </Dialog.Close>
            <button
              className="reject-button"
              type="button"
              disabled={disabled || submitting}
              onClick={() => void confirmRejection()}
            >
              {submitting ? "Rejecting..." : "Confirm rejection"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
