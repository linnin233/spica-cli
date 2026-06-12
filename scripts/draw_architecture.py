#!/usr/bin/env python3
"""Spica CLI — sharp-corner rectangles, no rendering artifacts."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyArrowPatch as FAP

fig, ax = plt.subplots(figsize=(22, 17))
ax.set_xlim(0, 22)
ax.set_ylim(0, 17)
ax.set_aspect('equal')
ax.axis('off')

BG   = '#ffffff'
BOX  = '#f5f5f5'
BOX2 = '#e8f0fe'
BOX3 = '#e6f4ea'
BOX4 = '#fef7e0'
BOX5 = '#fce4ec'
LINE = '#333333'
TEXT = '#222222'
GRAY = '#666666'

fig.set_facecolor(BG)
ax.set_facecolor(BG)

G  = 0.6   # horizontal gap between boxes
LG = 0.5   # vertical gap between layer boundaries

# ── helpers ──────────────────────────────────────────

class Box:
    """Sharp-corner rectangle. (x,y,w,h) is the exact bounding box."""
    def __init__(self, x, y, w, h, label, color=BOX, fs=10, bold=False):
        self.x, self.y, self.w, self.h = x, y, w, h
        r = Rectangle((x, y), w, h, facecolor=color, edgecolor=LINE, lw=1.5)
        ax.add_patch(r)
        wt = 'bold' if bold else 'normal'
        ax.text(x + w/2, y + h/2, label, color=TEXT, fontsize=fs,
                ha='center', va='center', fontweight=wt)
    def top(self):    return self.y + self.h
    def bottom(self): return self.y
    def left(self):   return self.x
    def right(self):  return self.x + self.w
    def cx(self):     return self.x + self.w/2
    def cy(self):     return self.y + self.h/2

def layer(x, y, w, h, label):
    """Dashed layer boundary — Rectangle, sharp corners."""
    r = Rectangle((x, y), w, h, facecolor='none', edgecolor=GRAY,
                  lw=1.0, linestyle='--')
    ax.add_patch(r)
    ax.text(x + 0.15, y + h/2, label, color=GRAY, fontsize=9,
            fontstyle='italic', va='center', rotation=90)

def arrow(x1, y1, x2, y2, label='', fs=9, g=0.15):
    dx, dy = x2 - x1, y2 - y1
    d = (dx**2 + dy**2)**0.5
    if d == 0: return
    ux, uy = dx/d, dy/d
    p = FAP((x1+ux*g, y1+uy*g), (x2-ux*g, y2-uy*g),
            arrowstyle='->', color=LINE, lw=1.8, mutation_scale=15)
    ax.add_patch(p)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        if abs(dx) > abs(dy):
            ax.text(mx, my+0.22, label, color=GRAY, fontsize=fs, ha='center', va='bottom')
        else:
            ax.text(mx+0.25, my, label, color=GRAY, fontsize=fs, ha='left', va='center')

def bidir(x1, y1, x2, y2, label='', fs=9):
    p = FAP((x1, y1), (x2, y2), arrowstyle='<->', color=LINE, lw=1.8,
            mutation_scale=15, shrinkA=2, shrinkB=2)
    ax.add_patch(p)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx+0.3, my, label, color=GRAY, fontsize=fs, ha='left', va='center')

# ═══════════════════════════════════════════════════════
# LAYER BOUNDARIES  (Rectangle, sharp corners, 0.5 apart)
# ═══════════════════════════════════════════════════════
# Pres:  13.5 .. 15.5
#         gap 0.5
# App:    9.5 .. 13.0
#         gap 0.5
# Dom:    5.0 ..  9.0
#         gap 0.5
# Inf:    1.0 ..  4.5

layer(0.3, 13.5, 21.4, 2.0, 'Presentation')
layer(0.3,  9.5, 21.4, 3.5, 'Application')
layer(0.3,  5.0, 21.4, 4.0, 'Domain')
layer(0.3,  1.0, 21.4, 3.5, 'Infrastructure')

# ═══════════════════════════════════════════════════════
# ROW 1 — Presentation  (boxes within 13.5..15.5)
#   y=13.8, h=1.4 → 13.8..15.2  (margin 0.3 each side)
# ═══════════════════════════════════════════════════════
r1y, r1h = 13.8, 1.4
tui    = Box(1.2, r1y, 3.4, r1h, 'TUI Mode\nfull-screen, streaming', BOX2, 9)
simple = Box(tui.right()+G, r1y, 3.4, r1h, 'Simple Mode\nreadline, --no-tui', BOX2, 9)
cmds   = Box(simple.right()+G, r1y, 5.2, r1h, 'CLI Commands\n/archive /history /compact /checkpoint\n/skill /mcp /status /init', BOX2, 8)
iqueue = Box(cmds.right()+G, r1y, 3.2, r1h, 'Input Queue\nbuffers, auto-drains', BOX, 9)
uicomp = Box(iqueue.right()+G, r1y, 2.8, r1h, 'UI\nspinner, diff,\nscrollback', BOX, 9)

# ═══════════════════════════════════════════════════════
# ROW 2 — Application  (boxes within 9.5..13.0)
#   y=9.8, h=2.9 → 9.8..12.7  (margin 0.3 each side)
# ═══════════════════════════════════════════════════════
r2y, r2h = 9.8, 2.9
agent = Box(1.2, r2y, 10.0, r2h,
            'SpicaAgent  (EventEmitter)\n\n'
            'processInput()  ·  runLoop()  ·  executeTools()  ·  compact()\n'
            '_fullHistory: append-only, never truncated\n'
            'provider.messages: LLM context, compressible',
            BOX3, 9)

events = Box(agent.right()+G, agent.top()-1.3, 3.2, 1.3,
             'Events\ntool_call / tool_result\nmessage / interrupt / done', BOX, 8)

interrupt = Box(events.right()+G, agent.top()-1.3, 2.8, 1.3,
                'Interrupt\nAbortController\ncancelSeq', BOX, 8)

session = Box(agent.right()+G, r2y+0.3,
              interrupt.right() - agent.right() - G, 1.4,
              'Session & Archive  (two-state model)\n'
              'saveSession() → session.json (active)\narchiveSession() → sessions/<id>.json (historical)',
              BOX, 8)

subagent = Box(interrupt.right()+G, r2y+0.5, 2.2, 2.4,
               'Sub-Agents\nexplore\nreview\nfix\nbuild', BOX, 8)

# ═══════════════════════════════════════════════════════
# ROW 3 — Domain  (boxes within 5.0..9.0)
#   y=5.3, h=3.4 → 5.3..8.7  (margin 0.3 each side)
# ═══════════════════════════════════════════════════════
r3y, r3h = 5.3, 3.4
llm = Box(1.2, r3y, 5.8, r3h,
          'LLMClient\n\nOpenAI-compatible streaming\n'
          'Providers: OpenAI, Anthropic,\nDeepSeek, Gemini, Groq\n'
          'RateLimiter  ·  TokenCounter\nFunctionCaller',
          BOX4, 8)

tools = Box(llm.right()+G, r3y, 6.4, r3h,
            'Tool System  (33 built-in + MCP)\n\n'
            'file: read, write, edit, multi_edit\n'
            'shell: bash, git\n'
            'search: grep, glob, find, list\n'
            'code: lint, test, code_health\n'
            'sub_agent  ·  syntax-check',
            BOX4, 8)

skills = Box(tools.right()+G, r3y, 6.4, r3h,
             'Skills & Hooks\n\n'
             '14 built-in skills\nbrainstorming, TDD, debugging,\ncode-review, git-worktrees\n\n'
             'Hooks: PreToolUse / PostToolUse\nnone < warn < confirm < block',
             BOX4, 8)

# ═══════════════════════════════════════════════════════
# ROW 4 — Infrastructure  (boxes within 1.0..4.5)
#   y=1.3, h=2.9 → 1.3..4.2  (margin 0.3 each side)
# ═══════════════════════════════════════════════════════
r4y, r4h = 1.3, 2.9
global_cfg = Box(1.2, r4y, 4.8, r4h,
                 'Global Config\n~/.spica/\nconfig.json  ·  skills.json\nmcp.json  ·  hooks.json', BOX5, 8)

active = Box(global_cfg.right()+G, r4y, 4.8, r4h,
             'Active Session\n.spica/session.json\nappend-only full history\nnever truncated', BOX5, 8, bold=True)

historical = Box(active.right()+G, r4y, 4.8, r4h,
                 'Historical Sessions\n.spica/sessions/<id>.json\none per archived session\nwith summary', BOX5, 8)

project = Box(historical.right()+G, r4y, 4.0, r4h,
              'Project State\n.spica/\nstate.json\nsnapshots/\nbackups/\ntasks.json', BOX5, 8)

# ═══════════════════════════════════════════════════════
# ARROWS — no crossing, no orphans
# ═══════════════════════════════════════════════════════

# ── Vertical: cross-layer arrows ──

# UI → Agent (user input enters system)
arrow(agent.cx(), r1y, agent.cx(), agent.top(), 'input')

# Agent ↔ LLM (main processing loop)
bidir(llm.cx(), agent.bottom(), llm.cx(), llm.top(), 'stream / response')

# Agent → Tools (tool execution)
arrow(tools.cx(), agent.bottom(), tools.cx(), tools.top(), 'execute')

# Agent → Storage (session persistence, through LLM-Tools gap)
mid_x = (llm.right() + tools.left()) / 2
arrow(mid_x, agent.bottom(), mid_x, active.top(), 'save', g=0.2)

# Active → Historical (archive session)
arrow(active.right(), active.cy(), historical.left(), historical.cy(), 'archive', g=0.08)

# Global Config → LLM (provider configuration)
arrow(global_cfg.cx(), global_cfg.top(), llm.cx(), llm.bottom(), 'config', g=0.15)

# ── Horizontal: within-row arrows (adjacent boxes only) ──

# Agent → Events (agent emits events, adjacent boxes)
arrow(agent.right(), events.cy(), events.left(), events.cy(), '', g=0.1)

# Events → UI Components (events drive TUI rendering)
arrow(events.cx(), events.top(), uicomp.cx(), uicomp.bottom(), 'render', g=0.1)

# Events → Interrupt (interrupt is an event type, adjacent boxes)
arrow(events.right(), events.cy(), interrupt.left(), events.cy(), '', g=0.1)

# Agent → Session (session management, adjacent boxes)
arrow(agent.right(), session.cy(), session.left(), session.cy(), '', g=0.1)

# Session → Sub-agents (task tool spawns sub-agents as part of session)
# session.right = interrupt.right, subagent is to the right of interrupt
arrow(session.right(), session.cy(), subagent.left(), session.cy(), 'spawn', g=0.1)

# Interrupt → Sub-agents (interrupt signals to sub-agents)
arrow(interrupt.right(), interrupt.cy(), subagent.left(), interrupt.cy(), 'abort', g=0.1)

# Tools → Skills (skills extend tool capabilities)
arrow(tools.right(), tools.cy(), skills.left(), tools.cy(), '', g=0.1)

# Historical → Project State (project metadata stored alongside sessions)
arrow(historical.right(), historical.cy(), project.left(), historical.cy(), '', g=0.1)

# ═══════════════════════════════════════════════════════

ax.text(11, 16.4, 'Spica CLI — System Architecture', color=TEXT, fontsize=18,
        ha='center', fontweight='bold')
ax.text(11, 16.0, 'AI Coding Agent  ·  Node.js + TypeScript  ·  Event-Driven',
        color=GRAY, fontsize=10, ha='center')
ax.text(11, 0.3, 'github.com/zisonzishen0415-stack/spica-cli  ·  MIT License',
        color=GRAY, fontsize=8, ha='center')

plt.tight_layout(pad=0.5)
plt.savefig('/home/zison/development/spica/spica-cli/docs/architecture.png', dpi=200,
            facecolor=BG, bbox_inches='tight', pad_inches=0.5)
plt.close()
print('Done')
