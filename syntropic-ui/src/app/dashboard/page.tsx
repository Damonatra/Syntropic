'use client';

import React, { useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  ShieldCheck,
  TrendingUp,
  DollarSign,
  Zap,
  ArrowUpRight,
} from 'lucide-react';

// Mock telemetry data representing monthly accumulation vs audit baseline
const chartData = [
  { month: 'Month 1', auditBaseline: 10000, realizedProtected: 14200, recoveredRfqs: 4500 },
  { month: 'Month 2', auditBaseline: 20000, realizedProtected: 38500, recoveredRfqs: 12100 },
  { month: 'Month 3', auditBaseline: 30000, realizedProtected: 72000, recoveredRfqs: 21400 },
  { month: 'Month 4', auditBaseline: 40000, realizedProtected: 115000, recoveredRfqs: 32800 },
  { month: 'Month 5', auditBaseline: 50000, realizedProtected: 142850, recoveredRfqs: 38400 },
];

export default function SyntropicDashboard() {
  const [metrics] = useState({
    roiMultiple: '14.2x',
    totalProtected: 142850,
    totalRecovered: 38400,
    retainerPaid: 12500,
  });

  const netValue = metrics.totalProtected + metrics.totalRecovered;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8 font-sans">
      {/* Header */}
      <div className="flex justify-between items-center border-b border-slate-800 pb-6 mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sky-400">
            Syntropic Executive ROI Portal
          </h1>
          <p className="text-sm text-slate-400">
            Real-time margin defense and automated profit recovery telemetry.
          </p>
        </div>
        <div className="flex items-center space-x-2 bg-emerald-950/50 border border-emerald-500/30 px-4 py-2 rounded-lg">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <span className="text-sm font-medium text-emerald-300">
            System Status: Protected &amp; Active
          </span>
        </div>
      </div>

      {/* "Paid For Itself" Headline Banner */}
      <div className="bg-gradient-to-r from-blue-950/60 to-slate-900 border border-blue-500/30 rounded-xl p-6 mb-8 flex items-center justify-between shadow-lg">
        <div>
          <div className="text-xs uppercase tracking-wider text-blue-400 font-semibold mb-1">
            Value Delivery Milestone
          </div>
          <div className="text-xl font-bold text-slate-100">
            Syntropic has generated{' '}
            <span className="text-emerald-400">
              ${netValue.toLocaleString()}
            </span>{' '}
            in net value on{' '}
            <span className="text-sky-400">
              ${metrics.retainerPaid.toLocaleString()}
            </span>{' '}
            in retainers paid—a{' '}
            <span className="text-emerald-400">{metrics.roiMultiple}</span>{' '}
            return this billing cycle.
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Total realized value (${netValue.toLocaleString()}) vs. retainer
            invested (${metrics.retainerPaid.toLocaleString()}).
          </p>
        </div>
        <div className="bg-blue-600/20 border border-blue-400/40 p-3 rounded-lg">
          <Zap className="w-8 h-8 text-blue-400" />
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div className="flex justify-between items-center text-slate-400 text-xs uppercase font-semibold mb-2">
            <span>Syntropic ROI Multiple</span>
            <TrendingUp className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-3xl font-extrabold text-emerald-400">
            {metrics.roiMultiple}
          </div>
          <div className="text-xs text-slate-500 mt-2 flex items-center">
            <ArrowUpRight className="w-3 h-3 text-emerald-400 mr-1" /> +2.4x vs
            last month
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div className="flex justify-between items-center text-slate-400 text-xs uppercase font-semibold mb-2">
            <span>Total Margin Protected</span>
            <DollarSign className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-3xl font-extrabold text-slate-100">
            ${metrics.totalProtected.toLocaleString()}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Intercepted pricing &amp; cost mismatches
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <div className="flex justify-between items-center text-slate-400 text-xs uppercase font-semibold mb-2">
            <span>Recovered Dropped Revenue</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-3xl font-extrabold text-slate-100">
            ${metrics.totalRecovered.toLocaleString()}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Overnight &amp; peak-hour auto-quotes
          </div>
        </div>
      </div>

      {/* Recharts Value Trend */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-slate-200 mb-4">
          Cumulative Profit Protection vs. Audit Baseline
        </h3>
        <div className="h-72 w-full">
          <ResponsiveContainer height="100%" width="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorProtected" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorBaseline" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="month" stroke="#64748b" />
              <YAxis stroke="#64748b" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                }}
              />
              <Legend />
              <Area
                dataKey="auditBaseline"
                fill="url(#colorBaseline)"
                fillOpacity={1}
                name="Audit Baseline Target ($)"
                stroke="#38bdf8"
                strokeWidth={2}
                strokeDasharray="6 4"
                type="monotone"
              />
              <Area
                dataKey="realizedProtected"
                fill="url(#colorProtected)"
                fillOpacity={1}
                name="Realized Profit Protected ($)"
                stroke="#10b981"
                strokeWidth={3}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </main>
  );
}
