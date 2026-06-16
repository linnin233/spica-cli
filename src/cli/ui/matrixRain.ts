/**
 * Matrix Rain — hacker-mode processing visualization.
 *
 * Algorithm: cmatrix-style "oldstyle" per-column shifting.
 * Each column independently cycles: GAP → DROP (full trail falls) → GAP → ...
 * Characters come from the agent's real output (feed()).
 * Dense coverage: most columns active at any time.
 */

const ESC = '\x1b';
const R = `${ESC}[0m`;
const H = `${ESC}[1;97m`;  // bright white (head only)
const G = `${ESC}[1;92m`;  // bright green (top of trail)
const g = `${ESC}[32m`;    // green (mid)
const D = `${ESC}[2;32m`;  // dim green (tail)
const K = `${ESC}[2;90m`;  // dark gray (ambient filler when no content)

export interface MatrixRainConfig { height: number; width: number; terminalRow: number; }

// ── Per-column state ────────────────────────────────────────────────────
interface Column {
  trail: string[];       // characters in this drop (index 0 = top)
  pos: number;           // top row of trail (can be negative = above screen)
  speed: number;         // ticks per shift
  tick: number;          // tick counter
  phase: 'gap' | 'drop'; // waiting or falling
  gapTimer: number;      // ticks until next drop
}

export class MatrixRainController {
  private timer: NodeJS.Timeout | null = null;
  private cfg: MatrixRainConfig;
  private cols: Column[] = [];
  private pending: string[] = [];
  private pIdx = 0;       // read position in pending buffer
  private active = false;

  private static readonly TICK_MS = 45;
  private static readonly TRAIL_MIN = 5;
  private static readonly TRAIL_MAX = 18;
  private static readonly GAP_MIN = 3;
  private static readonly GAP_MAX = 20;
  private static readonly SPEED_MIN = 1;
  private static readonly SPEED_MAX = 4;

  constructor(config: MatrixRainConfig) {
    this.cfg = config;
    this.initCols();
  }

  private initCols(): void {
    this.cols = [];
    for (let c = 0; c < this.cfg.width; c++) {
      this.cols.push(this.newColumn());
    }
  }

  private newColumn(): Column {
    return {
      trail: [],
      pos: -1,
      speed: MatrixRainController.SPEED_MIN +
        Math.floor(Math.random() * MatrixRainController.SPEED_MAX),
      tick: 0,
      phase: 'gap',
      gapTimer: Math.floor(Math.random() * MatrixRainController.GAP_MAX),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.active = true;
    this.dispatchAmbient(); // seed initial trails so screen isn't empty
    this.timer = setInterval(() => this.tick(), MatrixRainController.TICK_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cols = [];
    this.pending = [];
    this.active = false;
  }

  setActive(a: boolean): void { this.active = a; }

  resize(w: number, h: number, row: number): void {
    this.cfg = { width: w, height: h, terminalRow: row };
    // Rebuild columns for new width
    const old = this.cols;
    this.cols = [];
    for (let c = 0; c < w; c++) {
      this.cols.push(c < old.length ? old[c] : this.newColumn());
    }
  }

  // ── Feed ──────────────────────────────────────────────────────────────

  feed(text: string): void {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 32 || cp === 127) continue;
      this.pending.push(ch);
    }
    if (this.pending.length > 5000) {
      this.pending = this.pending.slice(-3000);
    }
  }

  // ── Content source ────────────────────────────────────────────────────

  /** Get next char from pending buffer, cycling if needed */
  private nextChar(): string | null {
    if (this.pending.length === 0) return null;
    const ch = this.pending[this.pIdx % this.pending.length];
    this.pIdx = (this.pIdx + 1) % this.pending.length;
    return ch;
  }

  /** Build a trail from pending content */
  private buildTrail(len: number): string[] {
    const t: string[] = [];
    for (let i = 0; i < len; i++) {
      const ch = this.nextChar();
      t.push(ch ?? ' ');
    }
    return t;
  }

  /** Seed initial trails so screen isn't blank on start */
  private dispatchAmbient(): void {
    for (const col of this.cols) {
      if (Math.random() < 0.6) {
        const len = MatrixRainController.TRAIL_MIN +
          Math.floor(Math.random() * (MatrixRainController.TRAIL_MAX - MatrixRainController.TRAIL_MIN));
        col.trail = this.buildTrail(len);
        col.pos = Math.floor(Math.random() * this.cfg.height);
        col.phase = 'drop';
      }
    }
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  private tick(): void {
    const { height } = this.cfg;

    for (const col of this.cols) {
      col.tick++;
      if (col.tick < col.speed) continue;
      col.tick = 0;

      if (col.phase === 'drop') {
        col.pos++;
        // Trail fully exited bottom?
        if (col.pos >= height) {
          col.trail = [];
          col.phase = 'gap';
          col.gapTimer = MatrixRainController.GAP_MIN +
            Math.floor(Math.random() * MatrixRainController.GAP_MAX);
        }
      } else {
        // gap phase
        col.gapTimer--;
        if (col.gapTimer <= 0) {
          const len = MatrixRainController.TRAIL_MIN +
            Math.floor(Math.random() * (MatrixRainController.TRAIL_MAX - MatrixRainController.TRAIL_MIN));
          col.trail = this.buildTrail(len);
          col.pos = -len; // start entirely above screen
          col.phase = 'drop';
        }
      }
    }

    this.renderFrame();
  }

  // ── Render ────────────────────────────────────────────────────────────

  private renderFrame(): void {
    const { width, height, terminalRow } = this.cfg;
    if (width <= 0 || height <= 0) return;

    // Build grid from column state
    const grid: Array<Array<{ ch: string; b: number } | null>> =
      Array.from({ length: height }, () => Array(width).fill(null));

    for (let c = 0; c < width; c++) {
      const col = this.cols[c];
      if (col.phase !== 'drop' || col.trail.length === 0) continue;

      for (let i = 0; i < col.trail.length; i++) {
        const row = col.pos + i; // pos = top of trail, i=0 → head at top
        if (row >= 0 && row < height) {
          const ch = col.trail[i];
          if (ch === ' ') continue;
          // Brightness: i=0 (top/head) = brightest, i=last (tail) = dimmest
          const b = col.trail.length - i;
          if (!grid[row][c]) {
            grid[row][c] = { ch, b };
          }
        }
      }
    }

    // Build ANSI output
    const lines: string[] = [];
    for (let r = 0; r < height; r++) {
      let line = '';
      let cur = -1;
      for (let c = 0; c < width; c++) {
        const cell = grid[r][c];
        if (cell) {
          let s: number;
          if (cell.b >= 12)       s = 4; // head — bright white
          else if (cell.b >= 6)  s = 3; // upper — bright green
          else if (cell.b >= 3)  s = 2; // mid — green
          else                   s = 1; // tail — dim green

          if (s !== cur) {
            line += R;
            if (s === 4)      line += H;
            else if (s === 3) line += G;
            else if (s === 2) line += g;
            else              line += D;
            cur = s;
          }
          line += cell.ch;
        } else {
          if (cur !== 0) { line += R; cur = 0; }
          line += ' ';
        }
      }
      if (cur !== 0) line += R;
      lines.push(`${ESC}[${terminalRow + r};1H${line}`);
    }

    process.stdout.write(`${ESC}[?25l${lines.join('')}${R}`);
  }

  // ── Clear ─────────────────────────────────────────────────────────────

  clear(): void {
    this.stop();
    const { height, terminalRow } = this.cfg;
    const cls: string[] = [];
    for (let r = 0; r < height; r++) {
      cls.push(`${ESC}[${terminalRow + r};1H${ESC}[2K`);
    }
    process.stdout.write(cls.join(''));
  }
}
