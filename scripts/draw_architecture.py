#!/usr/bin/env python3
"""Spica CLI architecture — larger fonts, same layout."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

fig, ax = plt.subplots(figsize=(32, 26))
ax.set_xlim(0, 32)
ax.set_ylim(0, 26)
ax.set_aspect('equal')
ax.axis('off')

BG   = '#0d1117'
W    = '#c9d1d9'
M    = '#8b949e'
BLU  = '#58a6ff'
GRN  = '#3fb950'
YLW  = '#d29922'
PNK  = '#f778ba'
PUR  = '#bc8cff'
TITLE_C = '#f0f6fc'

fig.set_facecolor(BG)
ax.set_facecolor(BG)

def draw_region(x, y, w, h, label, color, fs=16):
    r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.4",
                       facecolor=color, edgecolor=color, alpha=0.04,
                       linewidth=1.5, linestyle='--')
    ax.add_patch(r)
    ax.text(x + 0.5, y + h - 0.7, label, color=color, fontsize=fs,
            fontweight='bold')

def draw_solid_box(x, y, w, h, color, text, fs=13):
    r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.2",
                       facecolor=color, edgecolor=color, alpha=0.85, lw=1.8)
    ax.add_patch(r)
    lines = text.split('\n')
    line_h = min(0.85, (h - 0.6) / max(len(lines), 1))
    cy = y + h/2 + (len(lines) - 1) * line_h / 2
    for line in lines:
        ax.text(x + w/2, cy, line, color='white', fontsize=fs,
                ha='center', va='center', fontweight='bold')
        cy -= line_h

def draw_box(x, y, w, h, color, text, fs=13, alpha=0.12):
    r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.2",
                       facecolor=color, edgecolor=color, alpha=alpha, lw=1.8)
    ax.add_patch(r)
    lines = text.split('\n')
    line_h = min(0.75, (h - 0.6) / max(len(lines), 1))
    cy = y + h/2 + (len(lines) - 1) * line_h / 2
    for line in lines:
        ax.text(x + w/2, cy, line, color=W, fontsize=fs,
                ha='center', va='center')
        cy -= line_h

def arrow(x1, y1, x2, y2, c=M, lw=3.5):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='-|>', color=c, lw=lw,
                               connectionstyle='arc3,rad=0'))

# ── TITLE ──
ax.text(16, 25.2, 'Spica CLI — System Architecture', color=TITLE_C, fontsize=30,
        ha='center', va='center', fontweight='bold')
ax.text(16, 24.5, 'AI Coding Agent  |  Node.js + TypeScript  |  ESM', color=M,
        fontsize=14, ha='center', va='center')

# ═══ LAYER 1: USER INTERFACE  y=19.5..24.0  h=4.5 ═══
draw_region(0.5, 19.5, 31.0, 4.5, 'USER INTERFACE', BLU, fs=16)

draw_solid_box(1.5, 20.2, 6.0, 2.8, BLU,
               'TUI Mode\nfull screen\nbracketed paste', fs=13)

draw_solid_box(8.3, 20.2, 6.0, 2.8, BLU,
               'Simple Mode\n--no-tui\nreadline', fs=13)

draw_solid_box(15.1, 20.2, 6.5, 2.8, BLU,
               'CLI Commands\n/archive /history\n/compact /checkpoint\n/skill /mcp /status', fs=12)

draw_box(22.5, 20.8, 4.5, 2.0, BLU,
         'Input Queue\nmax 50, merge on drain', fs=13)

draw_box(27.8, 20.8, 3.5, 2.0, BLU,
         'UI Components\nspinner, diff\nscrollback', fs=13)

# ═══ LAYER 2: CORE AGENT  y=12.0..19.0  h=7.0 ═══
draw_region(0.5, 12.0, 24.3, 7.0, 'CORE — SpicaAgent Orchestrator', GRN, fs=16)

draw_solid_box(1.8, 13.8, 9.5, 4.2, GRN,
               'SpicaAgent\nEventEmitter-based\n\nprocessInput()  runLoop()\nexecuteTools()  compact()\ninterrupt()  setMessages()\n\n_fullHistory (append-only)\nprovider.messages (context)', fs=13)

draw_box(12.8, 15.5, 4.5, 2.8, GRN,
         'Events\ntool_call\ntool_result\nmessage\nreasoning\ninterrupt / done\ncontext_compressed', fs=12)

draw_box(18.0, 16.2, 4.0, 2.0, GRN,
         'Interrupt\nAbortController\ncancelSeq pattern', fs=12)

draw_box(12.8, 12.5, 9.2, 2.5, PUR,
         'Session & Archive\ntwo-state model\nsaveSession() → session.json (active)\narchiveSession() → sessions/<id>.json (historical)\nappend-only history, never truncated', fs=12, alpha=0.18)

draw_box(25.2, 17.6, 3.2, 2.0, GRN,
         'Sub-Agents\nexplore / review\nfix / build', fs=12)

draw_box(25.2, 15.2, 3.2, 2.0, GRN,
         'Compaction\n/compact\ncompressToTarget()', fs=12)

draw_box(25.2, 13.0, 3.2, 1.7, GRN,
         'Tool Conflict\nDetector', fs=12)

# ═══ LAYER 3: SERVICES  y=4.0..11.5  h=7.5 ═══
draw_region(0.5, 4.0, 24.3, 7.5, 'SERVICES', YLW, fs=16)

draw_solid_box(1.5, 8.0, 8.0, 3.2, YLW,
               'LLMClient\nOpenAI-compatible streaming\n\nFunctionCaller (tool dispatch)\nRateLimiter (req/tok per min)\nTokenCounter (context est.)', fs=13)

draw_box(10.5, 9.2, 5.5, 2.0, YLW,
         'Providers\nOpenAI / Anthropic\nDeepSeek / Gemini\nTogether AI / Groq', fs=12)

draw_solid_box(1.5, 4.5, 8.0, 3.0, YLW,
               'Tools (33 built-in)\nfile: read, write, edit\nshell: bash, git\nsearch: grep, glob\ncode: lint, test, code_health\nsub_agent (explore/review/fix/build)', fs=12)

draw_box(10.5, 5.8, 5.5, 2.0, YLW,
         'MCP Client\nModel Context Protocol\nexternal tool servers\nstdio / HTTP', fs=12)

draw_box(17.0, 9.2, 6.0, 2.0, YLW,
         'Hooks System\nPreToolUse / PostToolUse\nnone < warn < confirm < block\nglobal hooks take precedence', fs=12)

draw_box(17.0, 6.8, 6.0, 2.0, YLW,
         'Skills (14 built-in)\nbrainstorming, TDD\nsystematic-debugging\ngit-worktrees, code-review', fs=12)

draw_box(17.0, 4.5, 6.0, 1.6, YLW,
         'RuntimeState (Singleton)\n+ EventBus (pub/sub)', fs=12)

draw_box(10.5, 4.5, 5.5, 0.8, YLW,
         'Checkpoints  .spica/snapshots/', fs=11)

# ═══ LAYER 4: STORAGE (right column)  y=4.0..11.5 ═══
draw_region(25.2, 4.0, 6.3, 7.5, 'STORAGE', PNK, fs=16)

draw_solid_box(25.8, 9.5, 5.0, 1.7, PNK,
               '~/.spica/\nconfig.json  skills.json\nmcp.json  hooks.json', fs=12)

draw_solid_box(25.8, 7.5, 5.0, 1.6, PNK,
               'Active Session\n.spica/session.json\nappend-only full history', fs=12)

draw_solid_box(25.8, 5.8, 5.0, 1.3, PNK,
               'Historical Sessions\n.spica/sessions/<id>.json', fs=12)

draw_box(25.8, 4.5, 5.0, 0.9, PNK,
         'Project State  .spica/state.json', fs=12)

# ═══ ARROWS ═══
arrow(10, 22.0, 7, 18.0, BLU)
arrow(7, 13.8, 5, 11.2, GRN)
arrow(5.5, 11.0, 7, 13.5, YLW)
arrow(8, 12.5, 4, 8.0, GRN)
arrow(20, 12.5, 28, 9.5, GRN)
arrow(28, 4.5, 28.5, 9.2, YLW)
arrow(15, 15.5, 19, 22.0, M)

# Labels
ax.text(13.0, 20.5, 'user input', color=BLU, fontsize=12, ha='center')
ax.text(4.0, 12.6, 'stream()', color=GRN, fontsize=12, ha='center')
ax.text(7.5, 12.0, 'tool_calls', color=YLW, fontsize=12, ha='center')
ax.text(4.5, 10.3, 'execute', color=GRN, fontsize=12, ha='center')
ax.text(23.5, 11.3, 'save/load', color=GRN, fontsize=12, ha='center')
ax.text(17.5, 19.2, 'events → UI', color=M, fontsize=12, ha='center')

ax.text(16, 0.3, 'github.com/zisonzishen0415-stack/spica-cli  •  MIT License', color=M,
        fontsize=10, ha='center', va='center')

plt.tight_layout(pad=0.3)
plt.savefig('/home/zison/development/spica/spica-cli/docs/architecture.png', dpi=150,
            facecolor=BG, bbox_inches='tight', pad_inches=0.3)
plt.close()
print('Done')
