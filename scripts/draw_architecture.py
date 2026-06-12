#!/usr/bin/env python3
"""Spica CLI — academic block diagram. No overlaps, period."""

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

G = 0.6   # horizontal gap between boxes in same row
LG = 0.5  # vertical gap between layer boundaries

class Box:
    def __init__(self, x, y, w, h, label, color=BOX, fs=10, bold=False):
        self.x, self.y, self.w, self.h = x, y, w, h
        r = FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.1',
                           facecolor=color, edgecolor=LINE, lw=1.3)
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
    """Dashed layer boundary. Uses Rectangle (sharp corners)."""
    r = Rectangle((x, y), w, h, facecolor='none', edgecolor=GRAY, lw=1.0, ls='--')
    ax.add_patch(r)
    ax.text(x+0.15, y+h/2, label, color=GRAY, fontsize=8, fontstyle='italic',
            va='center', rotation=90)

# ── TITLE ──
ax.text(11, 16.4, 'Spica CLI — System Architecture', color=TEXT, fontsize=18,
        ha='center', fontweight='bold')
ax.text(11, 16.0, 'AI Coding Agent  ·  Node.js + TypeScript  ·  Event-Driven',
        color=GRAY, fontsize=10, ha='center')

# ═══════════════════════════════════════════════════
# LAYER 1: PRESENTATION
#   boundary: y=13.5..15.5  h=2.0
#   boxes:    y=13.8..15.2  h=1.4
#   margin inside boundary: 0.3 top, 0.3 bottom
# ═══════════════════════════════════════════════════
layer(0.3, 13.5, 21.4, 2.0, 'Presentation')

tui    = Box(1.2, 13.8, 3.4, 1.4, 'TUI Mode\nfull-screen, streaming', BOX2, 9)
simple = Box(tui.right()+G, 13.8, 3.4, 1.4, 'Simple Mode\nreadline, --no-tui', BOX2, 9)
cmds   = Box(simple.right()+G, 13.8, 5.2, 1.4, 'CLI Commands\n/archive /history /compact /checkpoint\n/skill /mcp /status /init', BOX2, 8)
iqueue = Box(cmds.right()+G, 13.8, 3.2, 1.4, 'Input Queue\nbuffers, auto-drains', BOX, 9)
uicomp = Box(iqueue.right()+G, 13.8, 2.8, 1.4, 'UI\nspinner, diff,\nscrollback', BOX, 9)

# ═══════════════════════════════════════════════════
# LAYER 2: APPLICATION
#   boundary: y=9.5..13.0  h=3.5
#   gap from layer 1: 13.5 - 13.0 = 0.5
#   boxes:    y=9.8..12.7  h=2.9
# ═══════════════════════════════════════════════════
layer(0.3, 9.5, 21.4, 3.5, 'Application')

agent_y, agent_h = 9.8, 2.9
agent = Box(1.2, agent_y, 10.0, agent_h,
            'SpicaAgent  (EventEmitter)\n\n'
            'processInput()  ·  runLoop()  ·  executeTools()  ·  compact()\n'
            '_fullHistory: append-only, never truncated\n'
            'provider.messages: LLM context, compressible',
            BOX3, 9)

events = Box(agent.right()+G, agent.top()-1.3, 3.2, 1.3,
             'Events\ntool_call / tool_result\nmessage / interrupt / done', BOX, 8)

interrupt = Box(events.right()+G, agent.top()-1.3, 2.8, 1.3,
                'Interrupt\nAbortController\ncancelSeq', BOX, 8)

session = Box(agent.right()+G, agent_y+0.3,
              interrupt.right() - agent.right() - G, 1.4,
              'Session & Archive  (two-state model)\n'
              'saveSession() → session.json (active)\narchiveSession() → sessions/<id>.json (historical)',
              BOX, 8)

subagent = Box(interrupt.right()+G, agent_y+0.5, 2.2, 2.4,
               'Sub-Agents\nexplore\nreview\nfix\nbuild', BOX, 8)

# ═══════════════════════════════════════════════════
# LAYER 3: DOMAIN
#   boundary: y=5.0..9.0  h=4.0
#   gap from layer 2: 9.5 - 9.0 = 0.5
#   boxes:    y=5.3..8.7  h=3.4
# ═══════════════════════════════════════════════════
layer(0.3, 5.0, 21.4, 4.0, 'Domain')

svc_y, svc_h = 5.3, 3.4
llm = Box(1.2, svc_y, 5.8, svc_h,
          'LLMClient\n\nOpenAI-compatible streaming\n'
          'Providers: OpenAI, Anthropic,\nDeepSeek, Gemini, Groq\n'
          'RateLimiter  ·  TokenCounter\nFunctionCaller',
          BOX4, 8)

tools = Box(llm.right()+G, svc_y, 6.4, svc_h,
            'Tool System  (33 built-in + MCP)\n\n'
            'file: read, write, edit, multi_edit\n'
            'shell: bash, git\n'
            'search: grep, glob, find, list\n'
            'code: lint, test, code_health\n'
            'sub_agent  ·  syntax-check',
            BOX4, 8)

skills = Box(tools.right()+G, svc_y, 6.4, svc_h,
             'Skills & Hooks\n\n'
             '14 built-in skills\nbrainstorming, TDD, debugging,\ncode-review, git-worktrees\n\n'
             'Hooks: PreToolUse / PostToolUse\nnone < warn < confirm < block',
             BOX4, 8)

# ═══════════════════════════════════════════════════
# LAYER 4: INFRASTRUCTURE
#   boundary: y=1.0..4.5  h=3.5
#   gap from layer 3: 5.0 - 4.5 = 0.5
#   boxes:    y=1.3..4.2  h=2.9
# ═══════════════════════════════════════════════════
layer(0.3, 1.0, 21.4, 3.5, 'Infrastructure')

sto_y, sto_h = 1.3, 2.9
global_cfg = Box(1.2, sto_y, 4.8, sto_h,
                 'Global Config\n~/.spica/\nconfig.json  ·  skills.json\nmcp.json  ·  hooks.json', BOX5, 8)

active = Box(global_cfg.right()+G, sto_y, 4.8, sto_h,
             'Active Session\n.spica/session.json\nappend-only full history\nnever truncated', BOX5, 8, bold=True)

historical = Box(active.right()+G, sto_y, 4.8, sto_h,
                 'Historical Sessions\n.spica/sessions/<id>.json\none per archived session\nwith summary', BOX5, 8)

project = Box(historical.right()+G, sto_y, 4.0, sto_h,
              'Project State\n.spica/\nstate.json\nsnapshots/\nbackups/\ntasks.json', BOX5, 8)

# ═══════════════════════════════════════════════════
# ARROWS
# ═══════════════════════════════════════════════════

# 1. UI → Agent (through 0.5 gap between layers)
arrow(agent.cx(), tui.bottom(), agent.cx(), agent.top(), 'user input')

# 2. Agent ↔ LLM (through 0.5 gap)
bidir(llm.cx(), agent.bottom(), llm.cx(), llm.top(), 'stream / response')

# 3. Agent → Tools (through 0.5 gap)
arrow(tools.cx(), agent.bottom(), tools.cx(), tools.top(), 'execute')

# 4. Agent → Storage (long arrow through gaps)
mid_x = (llm.right() + tools.left()) / 2
arrow(mid_x, agent.bottom(), mid_x, active.top(), 'save / load', gap=0.2)

# 5. Active → Historical (within same layer)
arrow(active.right(), active.cy(), historical.left(), historical.cy(), 'archive', gap=0.08)

# ═══════════════════════════════════════════════════

ax.text(11, 0.3, 'github.com/zisonzishen0415-stack/spica-cli  ·  MIT License',
        color=GRAY, fontsize=8, ha='center')

plt.tight_layout(pad=0.5)
plt.savefig('/home/zison/development/spica/spica-cli/docs/architecture.png', dpi=200,
            facecolor=BG, bbox_inches='tight', pad_inches=0.5)
plt.close()
print('Done')
