"""Generate charts for the Syntropic Backbone After Action Report.

Chart styling per skills/pdf/typesetting/charts.md:
- top/right spines deleted, bottom/left thin gray
- dashed grid 0.5pt at 20% opacity (or none when values are labeled)
- legend outside plot area, no frame
- colors from cascade palette only
- constrained_layout=True (no tight_layout / bbox_inches overrides)
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.font_manager as fm

fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')

import matplotlib.pyplot as plt

plt.rcParams['font.sans-serif'] = ['DejaVu Sans', 'Noto Sans SC']
plt.rcParams['axes.unicode_minus'] = False

# Cascade palette (from pdf.py palette.cascade, seed 26)
ACCENT = '#8e7324'
SEM_SUCCESS = '#4a855e'
SEM_ERROR = '#a54a42'
SEM_WARNING = '#9d8554'
TEXT_PRIMARY = '#1d1c1a'
TEXT_MUTED = '#85837b'
BORDER = '#d3cdba'

OUT_DIR = '/home/z/my-project/scripts/assets'
import os
os.makedirs(OUT_DIR, exist_ok=True)


def style_axes(ax, keep_left=False):
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['left'].set_visible(keep_left)
    ax.spines['bottom'].set_color(BORDER)
    ax.spines['bottom'].set_linewidth(0.8)
    if keep_left:
        ax.spines['left'].set_color(BORDER)
        ax.spines['left'].set_linewidth(0.8)
    ax.tick_params(colors=TEXT_MUTED, labelsize=10, length=0)


# ─────────────────────────────────────────────────────────────
# Chart 1: Verification posture by gate (horizontal stacked bars)
# ─────────────────────────────────────────────────────────────
gates = [
    'Task 3\nLayer 4 market-readiness audit',
    'Task 4\nPost-remediation verification',
    'Task 5\nFinal regression gate',
]
pass_counts = [2, 9, 9]
fail_counts = [5, 0, 0]
blocked_counts = [2, 0, 0]

fig, ax = plt.subplots(figsize=(8.2, 3.4), dpi=200, constrained_layout=True)
y = range(len(gates))[::-1]

lefts = [0, 0, 0]
b1 = ax.barh(list(y), pass_counts, height=0.52, color=SEM_SUCCESS,
             edgecolor='none', label='Pass')
lefts = [p for p in pass_counts]
b2 = ax.barh(list(y), fail_counts, height=0.52, left=lefts, color=SEM_ERROR,
             edgecolor='none', label='Fail')
lefts = [p + f for p, f in zip(pass_counts, fail_counts)]
b3 = ax.barh(list(y), blocked_counts, height=0.52, left=lefts, color=SEM_WARNING,
             edgecolor='none', label='Blocked')

# Value labels inside segments (skip zero segments)
for yi, (p, f, bl) in zip(y, zip(pass_counts, fail_counts, blocked_counts)):
    if p:
        ax.text(p / 2, yi, str(p), ha='center', va='center',
                color='white', fontsize=11, fontweight='bold')
    if f:
        ax.text(p + f / 2, yi, str(f), ha='center', va='center',
                color='white', fontsize=11, fontweight='bold')
    if bl:
        ax.text(p + f + bl / 2, yi, str(bl), ha='center', va='center',
                color='white', fontsize=11, fontweight='bold')

ax.set_yticks(list(y))
ax.set_yticklabels(gates, fontsize=10.5, color=TEXT_PRIMARY)
ax.set_xlim(0, 9.6)
ax.set_xticks(range(0, 10, 2))
ax.set_xlabel('Pre-flight verification matrix rows (9 total)', fontsize=10, color=TEXT_MUTED)
ax.grid(axis='x', linestyle='--', linewidth=0.5, alpha=0.2, color=TEXT_MUTED)
ax.set_axisbelow(True)
style_axes(ax)

# Legend outside the plot area, no frame
ax.legend(loc='lower left', bbox_to_anchor=(0.0, 1.02), ncol=3, frameon=False,
          fontsize=10, handlelength=1.2, handleheight=1.0, columnspacing=1.6)

fig.savefig(f'{OUT_DIR}/chart-verification.png')
plt.close(fig)

# ─────────────────────────────────────────────────────────────
# Chart 2: Margin defended by tenant (horizontal bars, values labeled)
# ─────────────────────────────────────────────────────────────
tenants = ['Apex Piping & Supply', 'Midwest Trade Wholesale',
           'Summit Industrial Fasteners', 'Gulf Coast Valve & Fitting']
margin_k = [28.6, 22.4, 12.3, 8.1]  # in $ thousands

fig, ax = plt.subplots(figsize=(8.2, 3.0), dpi=200, constrained_layout=True)
y = range(len(tenants))[::-1]
bars = ax.barh(list(y), margin_k, height=0.55, color=ACCENT, edgecolor='none')

for yi, v in zip(y, margin_k):
    ax.text(v + 0.45, yi, f'${v:,.1f}k', va='center', ha='left',
            fontsize=10.5, color=TEXT_PRIMARY, fontweight='bold')

ax.set_yticks(list(y))
ax.set_yticklabels(tenants, fontsize=10.5, color=TEXT_PRIMARY)
ax.set_xlim(0, 33.5)
ax.set_xticks([])
ax.grid(False)
style_axes(ax)
ax.set_xlabel('Margin defended, ledger-computed (USD thousands · total $71,400)',
              fontsize=10, color=TEXT_MUTED)

fig.savefig(f'{OUT_DIR}/chart-margin.png')
plt.close(fig)

print('charts written:',
      f'{OUT_DIR}/chart-verification.png',
      f'{OUT_DIR}/chart-margin.png')
