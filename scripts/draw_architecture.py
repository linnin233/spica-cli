#!/usr/bin/env python3
"""Spica CLI — academic-style system block diagram."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyBboxPatch, FancyArrowPatch
from matplotlib.patches import FancyArrowPatch as FAP

fig, ax = plt.subplots(figsize=(20, 16))
ax.set_xlim(0, 20)
ax.set_ylim(0, 16)
ax.set_aspect('equal')
ax.axis('off')

# Academic palette: white bg, black lines, muted fills
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

# ═══════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════

class Box:
    """A labeled block. Coordinates are (left, bottom, width, height)."""
    def __init__(self, x, y, w, h, label, color=BOX, fontsize=10, bold=False):
        self.x, self.y, self.w, self.h = x, y, w, h
        r = FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.1',
                           facecolor=color, edgecolor=LINE, lw=1.5)
        ax.add_patch(r)
        wt = 'bold' if bold else 'normal'
        ax.text(x + w/2, y + h/2, label, color=TEXT, fontsize=fontsize,
                ha='center', va='center', fontweight=wt)

    def top(self):    return self.y + self.h
    def bottom(self): return self.y
    def left(self):   return self.x
    def right(self):  return self.x + self.w
    def cx(self):     return self.x + self.w/2
    def cy(self):     return self.y + self.h/2

def arrow(x1, y1, x2, y2, color=LINE, lw=1.8, label='', fs=9, gap=0.15):
    """Draw a clean arrow from (x1,y1) to (x2,y2), with gap from endpoints.
    Supports horizontal or vertical arrows only."""
    dx, dy = x2 - x1, y2 - y1
    dist = (dx**2 + dy**2)**0.5
    if dist == 0:
        return
    ux, uy = dx/dist, dy/dist
    # Apply gap
    sx, sy = x1 + ux*gap, y1 + uy*gap
    ex, ey = x2 - ux*gap, y2 - uy*gap
    p = FAP((sx, sy), (ex, ey), arrowstyle='->', color=color, lw=lw,
            mutation_scale=15, shrinkA=0, shrinkB=0)
    ax.add_patch(p)
    if label:
        mx, my = (sx+ex)/2, (sy+ey)/2
        # Place label offset perpendicular to arrow direction
        if abs(dx) > abs(dy):  # horizontal
            ax.text(mx, my + 0.22, label, color=GRAY, fontsize=fs, ha='center', va='bottom')
        else:  # vertical
            ax.text(mx + 0.25, my, label, color=GRAY, fontsize=fs, ha='left', va='center')

def bidir_arrow(x1, y1, x2, y2, color=LINE, lw=1.8, label='', fs=9):
    """Bidirectional arrow. Shows a single line with arrowheads at both ends."""
    p = FAP((x1, y1), (x2, y2), arrowstyle='<->', color=color, lw=lw,
            mutation_scale=15, shrinkA=2, shrinkB=2)
    ax.add_patch(p)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx + 0.3, my, label, color=GRAY, fontsize=fs, ha='left', va='center')

# ═══════════════════════════════════════════════
# TITLE
# ═══════════════════════════════════════════════
ax.text(10, 15.5, 'Spica CLI — System Architecture', color=TEXT, fontsize=18,
        ha='center', fontweight='bold')
ax.text(10, 15.1, 'AI Coding Agent  ·  Node.js + TypeScript  ·  Event-Driven',
        color=GRAY, fontsize=10, ha='center')

# ═══════════════════════════════════════════════
# LAYER 1 — USER INTERFACE  (y~13.0..14.6)
# ═══════════════════════════════════════════════
ui_y = 13.0
ui_h = 1.4

tui    = Box(0.8, ui_y, 3.2, ui_h, 'TUI Mode\nfull-screen, streaming', BOX2, 9)
simple = Box(4.4, ui_y, 3.2, ui_h, 'Simple Mode\nreadline, --no-tui', BOX2, 9)
cmds   = Box(8.0, ui_y, 4.8, ui_h, 'CLI Commands\n/archive /history /compact /checkpoint\n/skill /mcp /status /init', BOX2, 8)
iqueue = Box(13.2, ui_y, 3.0, ui_h, 'Input Queue\nbuffers, auto-drains', BOX, 9)
uicomp = Box(16.6, ui_y, 2.6, ui_h, 'UI\nspinner, diff,\nscrollback', BOX, 9)

# ═══════════════════════════════════════════════
# LAYER 2 — CORE AGENT  (y~9.0..12.2)
# ═══════════════════════════════════════════════
agent_y = 9.0
agent_h = 3.0

agent = Box(0.8, agent_y, 9.5, agent_h,
            'SpicaAgent  (EventEmitter)\n\n'
            'processInput()  ·  runLoop()  ·  executeTools()  ·  compact()\n'
            '_fullHistory: append-only, never truncated\n'
            'provider.messages: LLM context, compressible',
            BOX3, 9)

events = Box(10.7, 10.5, 3.0, 1.3,
             'Events\ntool_call / tool_result\nmessage / interrupt / done', BOX, 8)

interrupt = Box(14.1, 10.5, 2.8, 1.3,
                'Interrupt\nAbortController\ncancelSeq', BOX, 8)

session = Box(10.7, 9.0, 6.2, 1.2,
              'Session & Archive  (two-state model)\n'
              'saveSession() → session.json (active)    ·    archiveSession() → sessions/<id>.json (historical)',
              BOX, 8, bold=False)

subagent = Box(17.3, 9.6, 2.0, 2.2,
               'Sub-Agents\nexplore\nreview\nfix\nbuild', BOX, 8)

# ═══════════════════════════════════════════════
# LAYER 3 — SERVICES  (y~4.0..8.2)
# ═══════════════════════════════════════════════
svc_y = 4.0
svc_h = 4.0

llm = Box(0.8, svc_y, 5.5, svc_h,
          'LLMClient\n\nOpenAI-compatible streaming\n'
          'Providers: OpenAI, Anthropic,\nDeepSeek, Gemini, Groq\n'
          'RateLimiter  ·  TokenCounter\nFunctionCaller',
          BOX4, 8)

tools = Box(6.7, svc_y, 6.0, svc_h,
            'Tool System  (33 built-in + MCP)\n\n'
            'file: read, write, edit, multi_edit\n'
            'shell: bash, git\n'
            'search: grep, glob, find, list\n'
            'code: lint, test, code_health\n'
            'sub_agent  ·  syntax-check',
            BOX4, 8)

skills = Box(13.1, svc_y, 6.1, svc_h,
             'Skills & Hooks\n\n'
             '14 built-in skills\nbrainstorming, TDD, debugging,\ncode-review, git-worktrees\n\n'
             'Hooks: PreToolUse / PostToolUse\nnone < warn < confirm < block',
             BOX4, 8)

# ═══════════════════════════════════════════════
# LAYER 4 — STORAGE  (y~1.0..3.2)
# ═══════════════════════════════════════════════
sto_y = 1.0
sto_h = 2.2

global_cfg = Box(0.8, sto_y, 4.5, sto_h,
                 'Global Config\n~/.spica/\nconfig.json  ·  skills.json\nmcp.json  ·  hooks.json', BOX5, 8)

active = Box(5.7, sto_y, 4.5, sto_h,
             'Active Session\n.spica/session.json\nappend-only full history\nnever truncated', BOX5, 8, bold=True)

historical = Box(10.6, sto_y, 4.5, sto_h,
                 'Historical Sessions\n.spica/sessions/<id>.json\none per archived session\nwith summary', BOX5, 8)

project = Box(15.5, sto_y, 3.7, sto_h,
              'Project State\n.spica/\nstate.json\nsnapshots/\nbackups/\ntasks.json', BOX5, 8)

# ═══════════════════════════════════════════════
# ARROWS — precise edge-to-edge, no crossings
# ═══════════════════════════════════════════════

# 1. UI → Agent: user input enters the system
arrow(5.5, 13.0, 5.5, 12.0, LINE, label='user input', fs=9)

# 2. Agent ↔ LLM: bidirectional — stream request and response
bidir_arrow(3.5, 9.0, 3.5, 8.0, LINE, label='stream / response', fs=9)

# 3. Agent → Tools: agent dispatches tool calls
arrow(9.7, 9.0, 9.7, 8.0, LINE, label='execute', fs=9)

# 4. Agent → Storage: save/load session, passing through service-layer gap
arrow(6.5, 9.0, 6.5, 3.2, LINE, label='save / load', fs=9, gap=0.2)

# 5. Active → Historical: archive moves session rightward
arrow(10.3, 2.1, 10.7, 2.1, LINE, label='archive', fs=9, gap=0.08)

# ═══════════════════════════════════════════════
# LAYER BOUNDARIES (dashed)
# ═══════════════════════════════════════════════
def layer_box(x, y, w, h, label):
    r = FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.2',
                       facecolor='none', edgecolor=GRAY, lw=1.2, linestyle='--')
    ax.add_patch(r)
    ax.text(x + 0.15, y + h - 0.25, label, color=GRAY, fontsize=9, fontstyle='italic')

layer_box(0.3, 12.7, 19.4, 2.0, 'Presentation')
layer_box(0.3, 8.7,  19.4, 3.6, 'Application')
layer_box(0.3, 3.7,  19.4, 4.5, 'Domain')
layer_box(0.3, 0.7,  19.4, 2.8, 'Infrastructure')

# ═══════════════════════════════════════════════
# FOOTER
# ═══════════════════════════════════════════════
ax.text(10, 0.5, 'github.com/zisonzishen0415-stack/spica-cli  ·  MIT License',
        color=GRAY, fontsize=8, ha='center')

plt.tight_layout(pad=0.5)
plt.savefig('/home/zison/development/spica/spica-cli/docs/architecture.png', dpi=200,
            facecolor=BG, bbox_inches='tight', pad_inches=0.5)
plt.close()
print('Done')
