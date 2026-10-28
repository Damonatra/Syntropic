"use client";

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  ListOrdered,
  ScanEye,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { RejectReviewDialog } from "@/components/reject-review-dialog";
import {
  PDFVisualCanvas,
  type BBox,
} from "@/components/PDFVisualCanvas";
import { cn } from "@/lib/utils";

type LineItem = {
  part_number: string;
  quantity: number;
  unit_of_measure?: string;
};

type Provenance = {
  page_no: number;
  bbox: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    coord_origin?: string;
  };
};

type ProvenanceBox = Provenance & { kind: "text" | "table" };

type WorkflowResult = {
  job_id: string;
  filename: string;
  status: string;
  review_decision?: "approve" | "reject" | null;
  review_note?: string | null;
  execution_result?: {
    confidence_score?: number;
    catalog_match_score?: number;
    extracted_data?: {
      line_items?: LineItem[];
      part_number?: string;
      quantity?: number;
      unit_of_measure?: string;
    };
    matched_catalog_items?: Array<{
      extracted_item?: LineItem;
      catalog_item?: Record<string, unknown> | null;
      rrf_score?: number;
    }>;
    execution_log?: string[];
    document_layout?: {
      file_name?: string;
      text_blocks?: Array<{ text?: string; provenance?: Provenance[] }>;
      tables?: Array<{
        cells?: Array<{ text?: string; provenance?: Provenance[] }>;
      }>;
    };
  };
};

type ReviewQueueItem = { job_id: string; filename: string };

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1"
).replace(/\/$/, "");
const TOKEN_KEY = "syntropic_access_token";

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return typeof body.detail === "string"
      ? body.detail
      : `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function provenanceBoxes(result?: WorkflowResult | null): ProvenanceBox[] {
  const layout = result?.execution_result?.document_layout;
  return [
    ...(layout?.text_blocks ?? []).flatMap((block) =>
      (block.provenance ?? []).map((item) => ({ ...item, kind: "text" as const })),
    ),
    ...(layout?.tables ?? []).flatMap((table) =>
      (table.cells ?? []).flatMap((cell) =>
        (cell.provenance ?? []).map((item) => ({
          ...item,
          kind: "table" as const,
        })),
      ),
    ),
  ];
}

export default function Home() {
  const [token, setToken] = useState("");
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [reviewNote, setReviewNote] = useState("");

  const boxes = useMemo(() => provenanceBoxes(result), [result]);
  const extracted = result?.execution_result?.extracted_data;
  const matchItems = result?.execution_result?.matched_catalog_items ?? [];
  const handlePdfError = useCallback(
    (message: string) => setError(`Could not render source PDF: ${message}`),
    [],
  );

  const updateResult = useCallback((job: WorkflowResult) => {
    setResult(job);
    const items = job.execution_result?.extracted_data?.line_items;
    setLineItems(
      items?.length
        ? items.map((item) => ({ ...item }))
        : job.execution_result?.extracted_data?.part_number
          ? [
              {
                part_number: job.execution_result.extracted_data.part_number,
                quantity: job.execution_result.extracted_data.quantity ?? 1,
                unit_of_measure:
                  job.execution_result.extracted_data.unit_of_measure ?? "EA",
              },
            ]
          : [],
    );
    setReviewNote(job.review_note ?? "");
  }, []);

  useEffect(() => {
    setToken(window.sessionStorage.getItem(TOKEN_KEY) ?? "");
  }, []);

  useEffect(() => {
    if (!token) {
      setQueue([]);
      return;
    }

    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`${API_BASE}/rfq/reviews`, {
          headers: authHeaders(token),
          cache: "no-store",
        });
        if (!response.ok) throw new Error(await readError(response));
        const reviews = (await response.json()) as ReviewQueueItem[];
        if (active) setQueue(reviews);
      } catch (requestError) {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Could not load the review queue.",
          );
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setPageNumber(1);
    setPageCount(0);
    setPdfUrl(null);
    const jobId = result?.job_id;
    if (!jobId || !token) return;

    void (async () => {
      try {
        const response = await fetch(
          `${API_BASE}/rfq/reviews/${encodeURIComponent(jobId)}/document`,
          { headers: authHeaders(token), cache: "no-store" },
        );
        if (!response.ok) throw new Error(await readError(response));
        const documentBlob = await response.blob();
        objectUrl = URL.createObjectURL(documentBlob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPdfUrl(objectUrl);
      } catch (requestError) {
        if (active) {
          setError(
            requestError instanceof Error
              ? `Could not load source PDF: ${requestError.message}`
              : "Could not load source PDF.",
          );
        }
      }
    })();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [result?.job_id, token]);

  async function loadJob(jobId: string) {
    setError("");
    setBusy(true);
    try {
      const response = await fetch(
        `${API_BASE}/rfq/reviews/${encodeURIComponent(jobId)}`,
        { headers: authHeaders(token), cache: "no-store" },
      );
      if (!response.ok) throw new Error(await readError(response));
      updateResult((await response.json()) as WorkflowResult);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Could not load RFQ.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocument(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!token) {
      setError("Enter a valid API access token before uploading a document.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${API_BASE}/rfq/process`, {
        method: "POST",
        headers: authHeaders(token),
        body: form,
      });
      if (!response.ok) throw new Error(await readError(response));
      updateResult((await response.json()) as WorkflowResult);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not process the PDF.",
      );
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  function editLineItem(index: number, field: keyof LineItem, value: string) {
    setLineItems((items) =>
      items.map((item, itemIndex) =>
        itemIndex === index
          ? {
              ...item,
              [field]: field === "quantity" ? Number(value) : value,
            }
          : item,
      ),
    );
  }

  async function submitReview(decision: "approve" | "reject"): Promise<boolean> {
    if (!result) return false;
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/rfq/${result.job_id}/review`, {
        method: "POST",
        headers: {
          ...authHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          decision,
          note: reviewNote,
          ...(decision === "approve" ? { line_items: lineItems } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      updateResult((await response.json()) as WorkflowResult);
      const queueRes = await fetch(`${API_BASE}/rfq/reviews`, {
        headers: authHeaders(token),
        cache: "no-store",
      });
      if (queueRes.ok) {
        setQueue((await queueRes.json()) as ReviewQueueItem[]);
      }
      return true;
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not submit the review decision.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveToken(value: string) {
    setToken(value.trim());
    if (value.trim()) window.sessionStorage.setItem(TOKEN_KEY, value.trim());
    else window.sessionStorage.removeItem(TOKEN_KEY);
  }

  function selectReview(jobId: string) {
    if (result?.job_id === jobId) return;
    void loadJob(jobId);
  }

  const pageBoxes = boxes.filter((item) => item.page_no === pageNumber);
  const pageHighlights: BBox[] = pageBoxes.map(({ bbox, kind }) => ({
    ...bbox,
    kind,
  }));
  const isAuthenticated = Boolean(token);

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>SYNTROPIC</strong>
            <span>RFQ AUDIT WORKSTATION</span>
          </div>
        </div>
        <div className="topbar-status flex items-center gap-4">
          <a
            href="/dashboard"
            className="text-xs text-[#777b86] hover:text-[#17191c] underline underline-offset-2 mr-2"
          >
            Telemetry &amp; ROI →
          </a>
          {isAuthenticated && (
            <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">
              Enclave Active
            </span>
          )}
          <span className={`status-dot ${isAuthenticated ? "online" : ""}`} />
          {isAuthenticated ? "API connected" : "Authentication required"}
        </div>
      </header>

      <section className="workbench">
        <aside className="sidebar">
          <section className="sidebar-section auth-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">SECURE ACCESS</span>
                <h2>Sign in</h2>
              </div>
            </div>
            <a
              className="secondary-button login-link"
              href={`${API_BASE}/auth/authorize`}
              target="_blank"
              rel="noreferrer"
            >
              <ShieldCheck size={15} />
              Open identity provider
              <ArrowUpRight size={14} />
            </a>
            <label className="field-label" htmlFor="access-token">
              Validated API access token
            </label>
            <input
              id="access-token"
              className="text-field token-field"
              type="password"
              autoComplete="off"
              placeholder="Paste the token from the API callback"
              value={token}
              onChange={(event) => saveToken(event.target.value)}
            />
            <p className="field-hint">
              The token is kept in this browser tab only.
            </p>
          </section>

          <section className="sidebar-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">HUMAN REVIEW</span>
                <h2>Review queue</h2>
              </div>
              <span className="count-pill">{queue.length}</span>
            </div>
            {queue.length ? (
              <ul className="queue-list">
                {queue.map((item) => (
                  <li key={item.job_id}>
                    <button
                      type="button"
                      className={cn(
                        "queue-item",
                        result?.job_id === item.job_id && "selected",
                      )}
                      onClick={() => selectReview(item.job_id)}
                      disabled={busy}
                    >
                      <span className="queue-icon">
                        <FileText size={15} />
                      </span>
                      <span className="queue-copy">
                        <strong>{item.filename}</strong>
                        <small>{item.job_id.slice(0, 8)}</small>
                      </span>
                      <ChevronRight className="queue-arrow" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-queue">
                {isAuthenticated
                  ? "No RFQs are waiting for review."
                  : "Sign in to load pending RFQs."}
              </p>
            )}
          </section>

          <section className="sidebar-section upload-panel">
            <span className="eyebrow">NEW WORKFLOW</span>
            <h2>Process an RFQ</h2>
            <p>Upload a PDF to extract line items and check catalog matches.</p>
            <label
              className={cn(
                "upload-button",
                (busy || !isAuthenticated) && "disabled",
              )}
            >
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={15} />
                  Processing...
                </>
              ) : (
                <>
                  <Upload size={15} />
                  Choose RFQ PDF
                </>
              )}
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={uploadDocument}
                disabled={busy || !isAuthenticated}
              />
            </label>
          </section>
        </aside>

        <section className="main-panel">
          {error && (
            <div className="error-banner" role="alert">
              <strong>Action required</strong>
              <span>{error}</span>
              <button type="button" onClick={() => setError("")} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}

          {result ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">RFQ JOB / {result.job_id.slice(0, 8)}</span>
                  <h1>{result.filename}</h1>
                </div>
                <span className={cn("state-badge", `state-${result.status}`)}>
                  <span className="status-dot" />
                  {result.status.replaceAll("_", " ")}
                </span>
              </div>

              <div className="metrics-row">
                <article className="metric-card">
                  <span><Activity size={12} /> EXTRACTION CONFIDENCE</span>
                  <strong>
                    {(
                      result.execution_result?.confidence_score ?? 0
                    ).toFixed(2)}
                  </strong>
                  <small>Model field validation</small>
                </article>
                <article className="metric-card">
                  <span><Check size={12} /> CATALOG MATCH</span>
                  <strong>
                    {(
                      result.execution_result?.catalog_match_score ?? 0
                    ).toFixed(2)}
                  </strong>
                  <small>Best candidate score</small>
                </article>
                <article className="metric-card">
                  <span><ListOrdered size={12} /> LINE ITEMS</span>
                  <strong>{extracted?.line_items?.length ?? lineItems.length}</strong>
                  <small>Extracted from source</small>
                </article>
                <article className="metric-card">
                  <span><ScanEye size={12} /> PROVENANCE BOXES</span>
                  <strong>{boxes.length}</strong>
                  <small>Document layout regions</small>
                </article>
              </div>

              <div className="content-grid">
                <section className="card document-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">SOURCE DOCUMENT</span>
                      <h2>Evidence viewer</h2>
                    </div>
                    {pageCount > 1 && (
                      <div className="page-controls">
                        <button
                          type="button"
                          onClick={() => setPageNumber((page) => Math.max(1, page - 1))}
                          disabled={pageNumber <= 1}
                          aria-label="Previous page"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span>
                          {pageNumber} / {pageCount}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setPageNumber((page) =>
                              Math.min(pageCount, page + 1),
                            )
                          }
                          disabled={pageNumber >= pageCount}
                          aria-label="Next page"
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="document-legend">
                    <span><i className="legend-text" /> Extracted text</span>
                    <span><i className="legend-table" /> Table cell</span>
                  </div>
                  <div className="pdf-stage">
                    {pdfUrl ? (
                      <PDFVisualCanvas
                        pdfUrl={pdfUrl}
                        pageNumber={pageNumber}
                        highlightBoxes={pageHighlights}
                        onPageCountChange={setPageCount}
                        onError={handlePdfError}
                      />
                    ) : (
                      <div className="document-placeholder">
                        <span className="placeholder-icon">
                          <FileText size={22} />
                        </span>
                        <strong>Source document unavailable</strong>
                        <span>The original PDF may have been removed.</span>
                      </div>
                    )}
                  </div>
                  <div className="document-caption">
                    <span>
                      {pageBoxes.length} provenance regions on this page
                    </span>
                    {result.execution_result?.document_layout?.file_name && (
                      <span>
                        {result.execution_result.document_layout.file_name}
                      </span>
                    )}
                  </div>
                </section>

                <div className="right-column">
                  <section className="card extraction-card">
                    <div className="card-heading">
                      <div>
                        <span className="eyebrow">STRUCTURED OUTPUT</span>
                        <h2>Extracted line items</h2>
                      </div>
                      <span className="count-pill">{lineItems.length}</span>
                    </div>
                    {lineItems.length ? (
                      <div className="line-items">
                        {lineItems.map((item, index) => (
                          <article className="line-item" key={index}>
                            <div className="line-item-title">
                              <span>LINE {String(index + 1).padStart(2, "0")}</span>
                              <span className="item-score">
                                {(
                                  matchItems[index]?.rrf_score ?? 0
                                ).toFixed(2)}{" "}
                                match
                              </span>
                            </div>
                            <label>
                              Part number
                              <input
                                className="text-field"
                                value={item.part_number}
                                onChange={(event) =>
                                  editLineItem(index, "part_number", event.target.value)
                                }
                                disabled={result.status !== "flagged_for_review"}
                              />
                            </label>
                            <div className="item-field-row">
                              <label>
                                Quantity
                                <input
                                  className="text-field"
                                  type="number"
                                  min={1}
                                  value={item.quantity}
                                  onChange={(event) =>
                                    editLineItem(index, "quantity", event.target.value)
                                  }
                                  disabled={result.status !== "flagged_for_review"}
                                />
                              </label>
                              <label>
                                UoM
                                <input
                                  className="text-field"
                                  value={item.unit_of_measure ?? "EA"}
                                  onChange={(event) =>
                                    editLineItem(
                                      index,
                                      "unit_of_measure",
                                      event.target.value,
                                    )
                                  }
                                  disabled={result.status !== "flagged_for_review"}
                                />
                              </label>
                            </div>
                            {matchItems[index]?.catalog_item ? (
                              <div className="catalog-candidate">
                                <span>CATALOG CANDIDATE</span>
                                <strong>
                                  {String(
                                    matchItems[index].catalog_item?.part_number ??
                                      "Candidate",
                                  )}
                                </strong>
                                <small>
                                  {String(
                                    matchItems[index].catalog_item?.description ?? "",
                                  )}
                                </small>
                              </div>
                            ) : (
                              <div className="no-match">No catalog candidate</div>
                            )}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="empty-queue">No line items were extracted.</p>
                    )}
                  </section>

                  {result.status === "flagged_for_review" && (
                    <form
                      className="card decision-card"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitReview("approve");
                      }}
                    >
                      <div className="card-heading">
                        <div>
                          <span className="eyebrow">HUMAN-IN-THE-LOOP</span>
                          <h2>Reviewer decision</h2>
                        </div>
                      </div>
                      <label>
                        Review note
                        <textarea
                          className="text-field note-field"
                          maxLength={1000}
                          value={reviewNote}
                          onChange={(event) => setReviewNote(event.target.value)}
                          placeholder="Add context for this decision"
                        />
                      </label>
                      <div className="decision-actions">
                        <RejectReviewDialog
                          disabled={busy}
                          onConfirm={() => submitReview("reject")}
                        />
                        <button className="approve-button" type="submit" disabled={busy}>
                          <Check size={14} />
                          Approve corrected RFQ
                        </button>
                      </div>
                    </form>
                  )}

                  <section className="card log-card">
                    <div className="card-heading">
                      <div>
                        <span className="eyebrow">LANGGRAPH RUN</span>
                        <h2>Execution trace</h2>
                      </div>
                    </div>
                    <ol className="execution-log">
                      {(result.execution_result?.execution_log ?? []).map(
                        (message, index) => (
                          <li key={`${index}-${message}`}>
                            <span className="log-index">{String(index + 1).padStart(2, "0")}</span>
                            <span>{message}</span>
                          </li>
                        ),
                      )}
                    </ol>
                  </section>
                </div>
              </div>
            </>
          ) : (
            <div className="welcome-state">
              <span className="welcome-icon">S</span>
              <span className="eyebrow">ENTERPRISE RFQ AUTOMATION</span>
              <h1>
                Audit with <em>full context.</em>
              </h1>
              <p>
                Process an RFQ, inspect extraction provenance on the source
                document, and resolve uncertain catalog matches.
              </p>
              <div className="welcome-steps">
                <span><b>01</b> Authenticate</span>
                <span><b>02</b> Process a PDF</span>
                <span><b>03</b> Review evidence</span>
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
