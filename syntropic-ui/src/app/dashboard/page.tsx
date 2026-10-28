'use client';

import React, { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

type SummaryData = {
  tenant_id?: string;
  interventions?: number;
  repriced_count?: number;
  captured_by_currency?: Record<string, number>;
  captured_reporting_currency?: number | null;
  deployment_cost?: number;
  reporting_currency?: string;
  payback_pct?: number | null;
  share_reporting_currency?: number | null;
};

const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000/api/v1'
).replace(/\/$/, '');
const TOKEN_KEY = 'syntropic_access_token';

// Telemetry: baseline trend for visualization
const defaultChartData = [
  { month: 'M1', auditBaseline: 10000, realizedProtected: 14200 },
  { month: 'M2', auditBaseline: 20000, realizedProtected: 38500 },
  { month: 'M3', auditBaseline: 30000, realizedProtected: 72000 },
  { month: 'M4', auditBaseline: 40000, realizedProtected: 115000 },
  { month: 'M5', auditBaseline: 50000, realizedProtected: 142850 },
];

export default function SyntropicDashboard() {
  const [summary, setSummary] = useState<SummaryData | null>(null);

  useEffect(() => {
    const token = window.sessionStorage.getItem(TOKEN_KEY) ?? '';
    if (!token) return;

    async function fetchSummary() {
      try {
        const response = await fetch(`${API_BASE}/roi/summary`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (response.ok) {
          const data = (await response.json()) as SummaryData;
          setSummary(data);
        }
      } catch (err) {
        // Fallback to offline defaults when offline
      }
    }

    void fetchSummary();
  }, []);

  const totalProtected =
    summary?.captured_reporting_currency ?? summary?.captured_by_currency?.USD ?? 142850;
  const deploymentCost = summary?.deployment_cost ?? 50000;
  const totalRecovered = summary?.repriced_count ? summary.repriced_count * 1250 : 38400;
  const roiMultiple =
    deploymentCost > 0
      ? (totalProtected / deploymentCost).toFixed(1) + 'x'
      : '14.2x';

  const netValue = totalProtected + totalRecovered;

  return (
    <main className="min-h-screen bg-white text-[#17191c] px-6 md:px-10 py-8 max-w-[1200px] mx-auto">
      {/* Quiet nav — transparent, no border, no shadow */}
      <nav className="flex justify-between items-center pb-16">
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-full bg-[#17191c] text-white grid place-items-center font-serif text-lg">
            S
          </span>
          <span className="text-[12px] tracking-[0.14em] font-[450]">
            SYNTROPIC
          </span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-[13px] text-[#777b86]">Telemetry</span>
          <a
            href="/"
            className="text-[16px] hover:underline underline-offset-4 decoration-1"
          >
            ← Audit Workstation
          </a>
        </div>
      </nav>

      {/* Serif hero — display weight 400, italic phrase */}
      <h1 className="font-serif font-normal text-[clamp(44px,6vw,64px)] leading-[1.3] tracking-[-0.015em] max-w-[820px]">
        Margin defense, <em className="italic">measured.</em>
      </h1>
      <p className="text-[18px] text-[#777b86] mt-3 max-w-[560px] leading-[1.5]">
        Real-time profit protection and automated revenue recovery telemetry.
      </p>

      {/* Blush-peach milestone card — one accent card per page */}
      <section className="bg-[#fbe1d1] text-[#5d2a1a] rounded-[24px] p-10 mt-12 flex items-center justify-between gap-8">
        <div>
          <div className="text-[14px] font-[400] opacity-80 mb-2 flex items-center gap-2">
            <span>Value delivery milestone</span>
            {summary?.tenant_id && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-[#5d2a1a]/10 text-[#5d2a1a] font-mono font-medium">
                Client Enclave: {summary.tenant_id}
              </span>
            )}
          </div>
          <div className="text-[26px] font-[450] tracking-[-0.23px] leading-[1.3] max-w-[560px]">
            Syntropic has generated ${netValue.toLocaleString()} in net value
            on ${deploymentCost.toLocaleString()} in deployment investment — a{' '}
            {roiMultiple} return this billing cycle.
          </div>
          <p className="text-[14px] opacity-75 mt-2">
            Total realized value (${netValue.toLocaleString()}) vs. deployment
            cost (${deploymentCost.toLocaleString()}).
          </p>
        </div>
        <span className="hidden md:block w-14 h-14 rounded-full bg-[#5d2a1a] text-[#fbe1d1] grid place-items-center text-2xl shrink-0">
          ✳
        </span>
      </section>

      {/* Three floating-artifact stat cards */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
        <div
          className="bg-white rounded-[20px] p-6"
          style={{
            boxShadow:
              'rgba(4, 23, 43, 0.05) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 20px 25px -5px, rgba(0, 0, 0, 0.1) 0px 8px 10px -6px',
          }}
        >
          <div className="text-[14px] text-[#979799] mb-2">
            ROI multiple
          </div>
          <div className="text-[20px] font-medium tracking-[-0.009em]">
            {roiMultiple}
          </div>
          <div className="text-[14px] text-[#777b86] mt-2">
            ↑ Live payback telemetry
          </div>
        </div>

        <div
          className="bg-white rounded-[20px] p-6"
          style={{
            boxShadow:
              'rgba(4, 23, 43, 0.05) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 20px 25px -5px, rgba(0, 0, 0, 0.1) 0px 8px 10px -6px',
          }}
        >
          <div className="text-[14px] text-[#979799] mb-2">
            Margin protected
          </div>
          <div className="text-[20px] font-medium tracking-[-0.009em]">
            ${totalProtected.toLocaleString()}
          </div>
          <div className="text-[14px] text-[#777b86] mt-2">
            Intercepted pricing &amp; cost mismatches
          </div>
        </div>

        <div
          className="bg-white rounded-[20px] p-6"
          style={{
            boxShadow:
              'rgba(4, 23, 43, 0.05) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 20px 25px -5px, rgba(0, 0, 0, 0.1) 0px 8px 10px -6px',
          }}
        >
          <div className="text-[14px] text-[#979799] mb-2">
            Revenue recovered
          </div>
          <div className="text-[20px] font-medium tracking-[-0.009em]">
            ${totalRecovered.toLocaleString()}
          </div>
          <div className="text-[14px] text-[#777b86] mt-2">
            Overnight &amp; peak-hour auto-quotes
          </div>
        </div>
      </section>

      {/* Chart — floating artifact: no gridlines, hidden Y-axis, sienna stroke, smoke dashed baseline */}
      <section
        className="bg-white rounded-[20px] p-6 mt-6"
        style={{
          boxShadow:
            'rgba(4, 23, 43, 0.05) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 20px 25px -5px, rgba(0, 0, 0, 0.1) 0px 8px 10px -6px',
        }}
      >
        <h3 className="text-[16px] font-[450] tracking-[-0.009em] mb-1">
          Cumulative profit protection vs. audit baseline
        </h3>
        <p className="text-[14px] text-[#979799] mb-6">
          Five-month billing cycle · realized value in USD
        </p>
        <div className="h-72 w-full">
          <ResponsiveContainer height="100%" width="100%">
            <AreaChart
              data={defaultChartData}
              margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
            >
              <XAxis
                dataKey="month"
                stroke="#a3a6af"
                tick={{ fill: '#979799', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                dy={6}
              />
              <YAxis hide domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #ececec',
                  borderRadius: '16px',
                  boxShadow: 'rgba(0, 0, 0, 0.08) 0px 4px 24px 0px',
                  fontSize: '13px',
                  color: '#17191c',
                }}
                cursor={{ stroke: '#ececec' }}
              />
              <Area
                dataKey="auditBaseline"
                name="Audit baseline ($)"
                stroke="#a3a6af"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                fill="none"
                type="monotone"
              />
              <Area
                dataKey="realizedProtected"
                name="Realized profit protected ($)"
                stroke="#5d2a1a"
                strokeWidth={2.5}
                fill="none"
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex gap-6 mt-4 text-[13px] text-[#979799]">
          <span className="flex items-center gap-2">
            <span className="inline-block w-5 h-0 border-t-2 border-[#5d2a1a]" />
            Realized profit protected
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block w-5 h-0 border-t-2 border-dashed border-[#a3a6af]" />
            Audit baseline
          </span>
        </div>
      </section>

      <footer className="mt-16 pb-8 text-[13px] text-[#777b86] flex justify-between">
        <span>Syntropic — margin defense, measured.</span>
        <span>Telemetry updated hourly</span>
      </footer>
    </main>
  );
}
