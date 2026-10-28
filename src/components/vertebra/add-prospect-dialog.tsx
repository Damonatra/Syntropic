"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VERTICALS } from "@/lib/vertebra/classify";
import { VERTICAL_LABELS } from "@/lib/vertebra/types";

interface AddProspectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIngested: (result: { status: string; message: string }) => void;
}

interface FormState {
  name: string;
  domain: string;
  vertical: string;
  region: string;
  city: string;
  stateProvince: string;
  revenueEstimateUsd: string;
  employeeCount: string;
  detectedErp: string;
  notes: string;
  contactFirstName: string;
  contactLastName: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  domain: "",
  vertical: "",
  region: "us",
  city: "",
  stateProvince: "",
  revenueEstimateUsd: "",
  employeeCount: "",
  detectedErp: "",
  notes: "",
  contactFirstName: "",
  contactLastName: "",
};

export function AddProspectDialog({ open, onOpenChange, onIngested }: AddProspectDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = async () => {
    if (!form.name.trim() || !form.domain.trim()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospect: {
            name: form.name.trim(),
            domain: form.domain.trim(),
            vertical: form.vertical || undefined,
            region: form.region as "us" | "ca",
            city: form.city || null,
            stateProvince: form.stateProvince || null,
            revenueEstimateUsd: form.revenueEstimateUsd ? Number(form.revenueEstimateUsd) : null,
            employeeCount: form.employeeCount ? Number(form.employeeCount) : null,
            detectedErp: form.detectedErp || null,
            notes: form.notes || null,
            contactFirstName: form.contactFirstName || null,
            contactLastName: form.contactLastName || null,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        onIngested({ status: "error", message: data.error ?? "Ingestion failed" });
      } else {
        onIngested({
          status: data.status,
          message:
            data.status === "ingested"
              ? `${form.name} is in the pipeline${data.caslScope ? " (CASL scope)" : ""}.`
              : data.message ?? "Prospect filtered from the corridor.",
        });
        setForm(EMPTY_FORM);
        onOpenChange(false);
      }
    } catch (error) {
      onIngested({ status: "error", message: error instanceof Error ? error.message : "Network error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[560px] overflow-y-auto rounded-[24px] border-[#ececec] p-7 sm:p-8">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-[26px] font-normal tracking-[-0.01em] text-[#17191c]">
            Add a distributor
          </DialogTitle>
          <DialogDescription className="text-[14.5px] leading-relaxed text-[#777b86]">
            The corridor gate applies: $10M–$150M revenue across PVF, Electrical,
            HVAC or Fluid Power. Canadian signals trigger CASL handling automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="meta mb-1.5 block">Company name *</span>
              <input className="field" placeholder="Keystone Pipe & Fitting" value={form.name} onChange={set("name")} />
            </label>
            <label className="block">
              <span className="meta mb-1.5 block">Domain *</span>
              <input className="field" placeholder="keystonepipe.com" value={form.domain} onChange={set("domain")} />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="meta mb-1.5 block">Vertical</span>
              <select className="field" value={form.vertical} onChange={set("vertical")}>
                <option value="">Auto-detect</option>
                {VERTICALS.map((vertical) => (
                  <option key={vertical} value={vertical}>
                    {VERTICAL_LABELS[vertical]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="meta mb-1.5 block">Region</span>
              <select className="field" value={form.region} onChange={set("region")}>
                <option value="us">United States</option>
                <option value="ca">Canada</option>
              </select>
            </label>
            <label className="block">
              <span className="meta mb-1.5 block">State / province</span>
              <input className="field" placeholder="OH or Ontario" value={form.stateProvince} onChange={set("stateProvince")} />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="meta mb-1.5 block">City</span>
              <input className="field" placeholder="Cleveland" value={form.city} onChange={set("city")} />
            </label>
            <label className="block">
              <span className="meta mb-1.5 block">Revenue (USD)</span>
              <input className="field" type="number" min="0" placeholder="42000000" value={form.revenueEstimateUsd} onChange={set("revenueEstimateUsd")} />
            </label>
            <label className="block">
              <span className="meta mb-1.5 block">Employees</span>
              <input className="field" type="number" min="1" placeholder="85" value={form.employeeCount} onChange={set("employeeCount")} />
            </label>
          </div>

          <label className="block">
            <span className="meta mb-1.5 block">Detected ERP / portal</span>
            <input className="field" placeholder="QuickBooks, Eclipse, customer portal…" value={form.detectedErp} onChange={set("detectedErp")} />
          </label>

          <label className="block">
            <span className="meta mb-1.5 block">Field notes (evidence for scoring)</span>
            <textarea
              className="field min-h-[84px] resize-y"
              placeholder="RFQs arrive by fax and email; quotes take two days; vendor SPAs tracked in a spreadsheet."
              value={form.notes}
              onChange={set("notes")}
            />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="meta mb-1.5 block">Contact first name</span>
              <input className="field" placeholder="Dana" value={form.contactFirstName} onChange={set("contactFirstName")} />
            </label>
            <label className="block">
              <span className="meta mb-1.5 block">Contact last name</span>
              <input className="field" placeholder="Whitfield" value={form.contactLastName} onChange={set("contactLastName")} />
            </label>
          </div>
        </div>

        <div className="mt-7 flex items-center justify-end gap-4">
          <button className="pill pill-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button className="pill pill-dark" onClick={submit} disabled={busy || !form.name.trim() || !form.domain.trim()}>
            {busy ? "Ingesting…" : "Ingest prospect"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
