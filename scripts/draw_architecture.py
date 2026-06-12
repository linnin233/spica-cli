#!/usr/bin/env python3
"""Spica CLI — no layer boundaries, just clean boxes with spacing."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch as FAP

fig, ax = plt.subplots(figsize=(22, 15))
ax.set_xlim(0, 22)
ax.set_ylim(0, 15)
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

G  = 0.6   # horizontal gap
VG = 0.7   # vertical gap between rows

class Box:
    def __init__(self, x, y, w, h, label, color=BOX, fs=10, bold=False):
        self.x, self.y, self.w, self.h = x, y, w, h
        r = FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.08',
                           facecolor=color, edgecolor=LINE, lw=1.2)
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

# ── TITLE ──
ax.text(11, 14.4, 'Spica CLI — System Architecture', color=TEXT, fontsize=18,
        ha='center', fontweight='bold')
ax.text(11, 14.0, 'AI Coding Agent  ·  Node.js + TypeScript  ·  Event-Driven',
        color=GRAY, fontsize=10, ha='center')

# ═══ ROW 1: User Interface  y=12.2..13.6  h=1.4 ═══
row1_y, row1_h = 12.2, 1.4
x = 1.2
tui    = Box(x, row1_y, 3.4, row1_h, 'TUI Mode\nfull-screen, streaming', BOX2, 9)
simple = Box((x:=tui.right()+G), row1_y, 3.4, row1_h, 'Simple Mode\nreadline, --no-tui', BOX2, 9)
cmds   = Box((x:=simple.right()+G), row1_y, 5.2, row1_h, 'CLI Commands\n/archive /history /compact /checkpoint\n/skill /mcp /status /init', BOX2, 8)
iqueue = Box((x:=cmds.right()+G), row1_y, 3.2, row1_h, 'Input Queue\nbuffers, auto-drains', BOX, 9)
uicomp = Box((x:=iqueue.right()+G), row1_y, 2.8, row1_h, 'UI\nspinner, diff,\nscrollback', BOX, 9)

# ═══ ROW 2: Core Agent  y=8.5..11.5  h=3.0 ═══
#   gap from row1: 12.2 - 11.5 = 0.7
row2_y, row2_h = 8.5, 3.0

agent = Box(1.2, row2_y, 10.0, row2_h,
            'SpicaAgent  (EventEmitter)\n\n'
            'processInput()  ·  runLoop()  ·  executeTools()  ·  compact()\n'
            '_fullHistory: append-only, never truncated\n'
            'provider.messages: LLM context, compressible',
            BOX3, 9)

events = Box(agent.right()+G, agent.top()-1.3, 3.2, 1.3,
             'Events\ntool_call / tool_result\nmessage / interrupt / done', BOX, 8)

interrupt = Box(events.right()+G, agent.top()-1.3, 2.8, 1.3,
                'Interrupt\nAbortController\ncancelSeq', BOX, 8)

session = Box(agent.right()+G, row2_y+0.3,
              interrupt.right() - agent.right() - G, 1.4,
              'Session & Archive  (two-state model)\n'
              'saveSession() → session.json (active)\narchiveSession() → sessions/<id>.json (historical)',
              BOX, 8)

subagent = Box(interrupt.right()+G, row2_y+0.5, 2.2, 2.5,
               'Sub-Agents\nexplore\nreview\nfix\nbuild', BOX, 8)

# ═══ ROW 3: Services  y=4.5..7.8  h=3.3 ═══
#   gap from row2: 8.5 - 7.8 = 0.7
row3_y, row3_h = 4.5, 3.3

llm = Box(1.2, row3_y, 5.8, row3_h,
          'LLMClient\n\nOpenAI-compatible streaming\n'
          'Providers: OpenAI, Anthropic,\nDeepSeek, Gemini, Groq\n'
          'RateLimiter  ·  TokenCounter\nFunctionCaller',
          BOX4, 8)

tools = Box(llm.right()+G, row3_y, 6.4, row3_h,
            'Tool System  (33 built-in + MCP)\n\n'
            'file: read, write, edit, multi_edit\n'
            'shell: bash, git\n'
            'search: grep, glob, find, list\n'
            'code: lint, test, code_health\n'
            'sub_agent  ·  syntax-check',
            BOX4, 8)

skills = Box(tools.right()+G, row3_y, 6.4, row3_h,
             'Skills & Hooks\n\n'
             '14 built-in skills\nbrainstorming, TDD, debugging,\ncode-review, git-worktrees\n\n'
             'Hooks: PreToolUse / PostToolUse\nnone < warn < confirm < block',
             BOX4, 8)

# ═══ ROW 4: Storage  y=1.5..3.9  h=2.4 ═══
#   gap from row3: 4.5 - 3.9 = 0.6
row4_y, row4_h = 1.5, 2.4

global_cfg = Box(1.2, row4_y, 4.8, row4_h,
                 'Global Config\n~/.spica/\nconfig.json  ·  skills.json\nmcp.json  ·  hooks.json', BOX5, 8)

active = Box(global_cfg.right()+G, row4_y, 4.8, row4_h,
             'Active Session\n.spica/session.json\nappend-only full history\nnever truncated', BOX5, 8, bold=True)

historical = Box(active.right()+G, row4_y, 4.8, row4_h,
                 'Historical Sessions\n.spica/sessions/<id>.json\none per archived session\nwith summary', BOX5, 8)

project = Box(historical.right()+G, row4_y, 4.0, row4_h,
              'Project State\n.spica/\nstate.json\nsnapshots/\nbackups/\ntasks.json', BOX5, 8)

# ═══ ARROWS ═══

arrow(agent.cx(), row1_y, agent.cx(), agent.top(), 'user input')
bidir(llm.cx(), agent.bottom(), llm.cx(), llm.top(), 'stream / response')
arrow(tools.cx(), agent.bottom(), tools.cx(), tools.top(), 'execute')
mid_x = (llm.right() + tools.left()) / 2
arrow(mid_x, agent.bottom(), mid_x, active.top(), 'save / load', gap=0.2)
arrow(active.right(), active.cy(), historical.left(), historical.cy(), 'archive', gap=0.08)

# ═══ ROW LABELS (left margin) ═══
labels = [
    (row1_y+row1_h/2, 'Presentation'),
    (row2_y+row2_h/2, 'Application'),
    (row3_y+row3_h/2, 'Domain'),
    (row4_y+row4_h/2, 'Infrastructure'),
]
for y, name in labels:
    ax.text(0.15, y, name, color=GRAY, fontsize=8, fontstyle='italic',
            va='center', rotation=90)

ax.text(11, 0.3, 'github.com/zisonzishen0415-stack/spica-cli  ·  MIT License',
        color=GRAY, fontsize=8, ha='center')

plt.tight_layout(pad=0.5)
plt.savefig('/home/zison/development/spica/spica-cli/docs/architecture.png', dpi=200,
            facecolor=BG, bbox_inches='tight', pad_inches=0.5)
plt.close()
print('Done')
