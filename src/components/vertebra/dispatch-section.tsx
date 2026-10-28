"use client";

import { OutboxEventRow, ProspectRow } from "@/lib/vertebra/types";
import { calendarFollowupUrl } from "@/lib/vertebra/casl";

interface DispatchSectionProps {
  prospects: ProspectRow[];
  outbox: OutboxEventRow[];
  onExportCsv: () => void;
}

export function DispatchSection({ prospects, outbox, onExportCsv }: DispatchSectionProps) {
  const channelA = prospects.filter((p) => p.dispatch?.channel === "channel_a_automated_email");
  const channelB = prospects.filter((p) => p.dispatch?.channel === "channel_b_josias_high_touch");
  const pendingHighTouch = channelB.filter((p) => !p.highTouchExported);

  return (
    <section id="dispatch" className="scroll-mt-20 bg-[#fafafb] py-20 sm:py-24">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="max-w-[640px]">
          <p className="tag mb-4 uppercase">Dual-channel dispatch</p>
          <h2 className="heading text-[#17191c]">
            Two channels. <span className="italic-accent">One router.</span>
          </h2>
          <p className="subhead mt-5">
            QLV 70 and above rides Channel A — automated outbound from rotating
            secondary domains. Everything else lands in the Josias high-touch
            queue, where a human closes with craft.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Channel A */}
          <div className="artifact p-6 sm:p-7">
            <div className="flex items-baseline justify-between">
              <h3 className="font-display text-[24px] text-[#17191c]">Channel A · Automated email</h3>
              <span className="tag uppercase">{channelA.length} routed</span>
            </div>
            <p className="mt-2 text-[14.5px] leading-relaxed text-[#777b86]">
              Rotating pool <span className="text-[#17191c]">syntropic-os.com</span> and siblings,
              warmup-aware caps (40/day, 8/hour per domain), 90-second send gaps, CASL
              footer plus RFC 8058 one-click unsubscribe on every Canadian send.
            </p>
            <div className="mt-5 space-y-2.5">
              {channelA.slice(0, 4).map((prospect) => (
                <div key={prospect.id} className="flex items-center justify-between gap-3 border-b border-[#f2f2f3] pb-2.5 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-[14.5px] text-[#17191c]">{prospect.name}</p>
                    <p className="truncate text-[12.5px] text-[#a3a6af]">
                      {prospect.dispatch?.subject ?? "queued"}
                    </p>
                  </div>
                  <span className="tag shrink-0">{prospect.dispatch?.status ?? "queued"}</span>
                </div>
              ))}
              {channelA.length === 0 ? (
                <p className="text-[13.5px] text-[#a3a6af]">
                  No Channel A dispatches yet — score prospects to 70+ and route them.
                </p>
              ) : null}
            </div>
          </div>

          {/* Channel B */}
          <div className="artifact p-6 sm:p-7">
            <div className="flex items-baseline justify-between">
              <h3 className="font-display text-[24px] text-[#17191c]">Channel B · Josias high-touch</h3>
              <span className="tag uppercase">{pendingHighTouch.length} pending export</span>
            </div>
            <p className="mt-2 text-[14.5px] leading-relaxed text-[#777b86]">
              Structured CSV queues with evidence-backed opening hooks, outbox events
              written to Neon on every state change, and Google Calendar follow-ups
              scheduled inside the rep working window.
            </p>
            <div className="mt-5 space-y-2.5">
              {channelB.slice(0, 4).map((prospect) => {
                const contact = prospect.contact
                  ? `${prospect.contact.firstName} ${prospect.contact.lastName}`
                  : "unknown contact";
                const hook = prospect.score?.hooks[0]?.body ?? "hook pending";
                return (
                  <div key={prospect.id} className="flex items-center justify-between gap-3 border-b border-[#f2f2f3] pb-2.5 last:border-0">
                    <div className="min-w-0">
                      <p className="truncate text-[14.5px] text-[#17191c]">
                        {prospect.name} · {contact}
                      </p>
                      <p className="truncate text-[12.5px] text-[#a3a6af]">{hook}</p>
                    </div>
                    <a
                      className="pill pill-ghost pill-small shrink-0"
                      href={calendarFollowupUrl({
                        company: prospect.name,
                        contact,
                        hook,
                        qlvScore: prospect.score?.qlvScore ?? 0,
                      })}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Schedule ↗
                    </a>
                  </div>
                );
              })}
              {channelB.length === 0 ? (
                <p className="text-[13.5px] text-[#a3a6af]">
                  Nothing queued — sub-70 scores land here automatically.
                </p>
              ) : null}
            </div>
            <button className="pill pill-dark mt-6" onClick={onExportCsv}>
              Export pending CSV ({pendingHighTouch.length})
            </button>
          </div>
        </div>

        {/* Outbox log */}
        <div className="artifact mt-6 overflow-hidden">
          <div className="flex items-baseline justify-between px-6 pt-5">
            <h3 className="font-display text-[22px] text-[#17191c]">Outbox event log</h3>
            <span className="tag">{outbox.length} recent</span>
          </div>
          <div className="scroll-slim max-h-[240px] overflow-y-auto px-6 pb-5 pt-3">
            {outbox.length === 0 ? (
              <p className="text-[13.5px] text-[#a3a6af]">
                No events yet — ingest, score and dispatch write here atomically.
              </p>
            ) : (
              <ul className="space-y-2">
                {outbox.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-4 text-[13.5px]">
                    <span className="shrink-0 font-mono text-[12px] text-[#979799]">
                      {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[#17191c]">{event.eventType}</span>
                    <span className="hidden min-w-0 flex-1 truncate text-[#a3a6af] sm:block">
                      {JSON.stringify(event.payload).slice(0, 90)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
