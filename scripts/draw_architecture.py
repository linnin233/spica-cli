#!/usr/bin/env python3
"""Spica CLI — academic block diagram with clean spacing."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, FancyArrowPatch as FAP

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

# ── helpers ────────────────────────────────────

class Box:
    def __init__(self, x, y, w, h, label, color=BOX, fs=10, bold=False):
        self.x, self.y, self.w, self.h = x, y, w, h
        r = FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.1',
                           facecolor=color, edgecolor=LINE, lw=1.5)
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

def arrow(x1, y1, x2, y2, label='', fs=9, gap=0.15):
    dx, dy = x2 - x1, y2 - y1
    d = (dx**2 + dy**2)**0.5
    if d == 0: return
    ux, uy = dx/d, dy/d
    p = FAP((x1+ux*gap, y1+uy*gap), (x2-ux*gap, y2-uy*gap),
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

def layer(x, y, w, h, label):
    r = Rectangle((x, y), w, h, facecolor='none', edgecolor=GRAY, lw=1.0, ls='--')
    ax.add_patch(r)
    ax.text(x+0.15, y+h/2, label, color=GRAY, fontsize=8, fontstyle='italic',
            va='center', rotation=90)

# ── title ──────────────────────────────────────

ax.text(11, 16.4, 'Spica CLI — System Architecture', color=TEXT, fontsize=18,
        ha='center', fontweight='bold')
ax.text(11, 16.0, 'AI Coding Agent  ·  Node.js + TypeScript  ·  Event-Driven',
        color=GRAY, fontsize=10, ha='center')

# ── layer 1: user interface ────────────────────
# boxes at y=14.0, h=1.5  (14.0..15.5)
# layer boundary: y=13.7..15.7

G = 0.6  # horizontal gap

tui    = Box(1.2, 14.0, 3.4, 1.5, 'TUI Mode\nfull-screen, streaming', BOX2, 9)
simple = Box(tui.right()+G, 14.0, 3.4, 1.5, 'Simple Mode\nreadline, --no-tui', BOX2, 9)
cmds   = Box(simple.right()+G, 14.0, 5.2, 1.5, 'CLI Commands\n/archive /history /compact /checkpoint\n/skill /mcp /status /init', BOX2, 8)
iqueue = Box(cmds.right()+G, 14.0, 3.2, 1.5, 'Input Queue\nbuffers, auto-drains', BOX, 9)
uicomp = Box(iqueue.right()+G, 14.0, 2.8, 1.5, 'UI\nspinner, diff,\nscrollback', BOX, 9)

# ── layer 2: core agent ────────────────────────
# agent box at y=10.0, h=3.5  (10.0..13.5)
# layer boundary: y=9.5..13.7

agent = Box(1.2, 10.0, 10.0, 3.5,
            'SpicaAgent  (EventEmitter)\n\n'
            'processInput()  ·  runLoop()  ·  executeTools()  ·  compact()\n'
            '_fullHistory: append-only, never truncated\n'
            'provider.messages: LLM context, compressible',
            BOX3, 9)

events = Box(agent.right()+G, agent.top()-1.5, 3.2, 1.5,
             'Events\ntool_call / tool_result\nmessage / interrupt / done', BOX, 8)

interrupt = Box(events.right()+G, agent.top()-1.5, 2.8, 1.5,
                'Interrupt\nAbortController\ncancelSeq', BOX, 8)

session = Box(agent.right()+G, agent.y+0.3,
              interrupt.right() - agent.right() - G, 1.7,
              'Session & Archive  (two-state model)\n'
              'saveSession() → session.json (active)\narchiveSession() → sessions/<id>.json (historical)',
              BOX, 8)

subagent = Box(interrupt.right()+G, agent.y+0.5, 2.2, 3.0,
               'Sub-Agents\nexplore\nreview\nfix\nbuild', BOX, 8)

# ── layer 3: services ──────────────────────────
# boxes at y=5.5, h=4.0  (5.5..9.5)
# layer boundary: y=5.0..9.8

llm = Box(1.2, 5.5, 5.8, 4.0,
          'LLMClient\n\nOpenAI-compatible streaming\n'
          'Providers: OpenAI, Anthropic,\nDeepSeek, Gemini, Groq\n'
          'RateLimiter  ·  TokenCounter\nFunctionCaller',
          BOX4, 8)

tools = Box(llm.right()+G, 5.5, 6.4, 4.0,
            'Tool System  (33 built-in + MCP)\n\n'
            'file: read, write, edit, multi_edit\n'
            'shell: bash, git\n'
            'search: grep, glob, find, list\n'
            'code: lint, test, code_health\n'
            'sub_agent  ·  syntax-check',
            BOX4, 8)

skills = Box(tools.right()+G, 5.5, 6.4, 4.0,
             'Skills & Hooks\n\n'
             '14 built-in skills\nbrainstorming, TDD, debugging,\ncode-review, git-worktrees\n\n'
             'Hooks: PreToolUse / PostToolUse\nnone < warn < confirm < block',
             BOX4, 8)

# ── layer 4: storage ───────────────────────────
# boxes at y=1.5, h=2.5  (1.5..4.0)
# layer boundary: y=1.0..4.2

global_cfg = Box(1.2, 1.5, 4.8, 2.5,
                 'Global Config\n~/.spica/\nconfig.json  ·  skills.json\nmcp.json  ·  hooks.json', BOX5, 8)

active = Box(global_cfg.right()+G, 1.5, 4.8, 2.5,
             'Active Session\n.spica/session.json\nappend-only full history\nnever truncated', BOX5, 8, bold=True)

historical = Box(active.right()+G, 1.5, 4.8, 2.5,
                 'Historical Sessions\n.spica/sessions/<id>.json\none per archived session\nwith summary', BOX5, 8)

project = Box(historical.right()+G, 1.5, 4.0, 2.5,
              'Project State\n.spica/\nstate.json\nsnapshots/\nbackups/\ntasks.json', BOX5, 8)

# ── layer boundaries (Rectangle, no rounding) ──

layer(0.3, 13.7, 21.4, 2.0, 'Presentation')
layer(0.3,  9.5, 21.4, 4.2, 'Application')
layer(0.3,  5.0, 21.4, 4.8, 'Domain')
layer(0.3,  1.0, 21.4, 3.2, 'Infrastructure')

# Check: layer boundaries do not overlap because:
#   Pres 13.7..15.7  → gap 0  →  App 9.5..13.7  (rect, shared edge ok)
#   App   9.5..13.7  → gap 0  →  Dom 5.0..9.8   (rect, shared edge ok)
#   Dom   5.0..9.8   → gap 0.8 →  Inf 1.0..4.2  (spacing for arrow)

# ── arrows ─────────────────────────────────────

# 1. UI → Agent
arrow(agent.cx(), 14.0, agent.cx(), agent.top(), 'user input')

# 2. Agent ↔ LLM
bidir(llm.cx(), agent.bottom(), llm.cx(), llm.top(), 'stream / response')

# 3. Agent → Tools
arrow(tools.cx(), agent.bottom(), tools.cx(), tools.top(), 'execute')

# 4. Agent → Storage (through gap between LLM and Tools)
mid_x = (llm.right() + tools.left()) / 2
arrow(mid_x, agent.bottom(), mid_x, active.top(), 'save / load', gap=0.2)

# 5. Active → Historical
arrow(active.right(), active.cy(), historical.left(), historical.cy(), 'archive', gap=0.08)

# ── footer ─────────────────────────────────────
ax.text(11, 0.3, 'github.com/zisonzishen0415-stack/spica-cli  ·  MIT License',
        color=GRAY, fontsize=8, ha='center')

plt.tight_layout(pad=0.5)
plt.savefig('/home/zison/development/spica/spica-cli/docs/architecture.png', dpi=200,
            facecolor=BG, bbox_inches='tight', pad_inches=0.5)
plt.close()
print('Done')
