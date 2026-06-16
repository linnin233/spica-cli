/**
 * Matrix Rain — hacker-mode processing visualization.
 *
 * Each content type has a distinct color so the rain is semantically readable:
 *   thinking  → green   (reasoning)
 *   output    → cyan    (final assistant response)
 *   tool      → yellow  (tool calls / results)
 *   subagent  → blue    (subagent streams)
 *   error     → red     (errors)
 */

const ESC = '\x1b';
const R = `${ESC}[0m`;
const WH = `${ESC}[1;97m`;   // head (all types share white head)

// Color palettes per type: [bright, normal, dim]
const PALETTE: Record<string, [string, string, string]> = {
  thinking: [`${ESC}[1;92m`, `${ESC}[32m`, `${ESC}[2;32m`],   // green
  output:   [`${ESC}[1;96m`, `${ESC}[36m`, `${ESC}[2;36m`],   // cyan
  tool:     [`${ESC}[1;93m`, `${ESC}[33m`, `${ESC}[2;33m`],   // yellow
  subagent: [`${ESC}[1;94m`, `${ESC}[34m`, `${ESC}[2;34m`],   // blue
  error:    [`${ESC}[1;91m`, `${ESC}[31m`, `${ESC}[2;31m`],   // red
};

export type RainType = 'thinking' | 'output' | 'tool' | 'subagent' | 'error';
export interface MatrixRainConfig { height: number; width: number; terminalRow: number; }

// ── Per-column state ────────────────────────────────────────────────────

interface TrailChar { ch: string; type: RainType }

interface Column {
  trail: TrailChar[];
  pos: number;
  speed: number;
  tick: number;
  phase: 'gap' | 'drop';
  gapTimer: number;
}

export class MatrixRainController {
  private timer: NodeJS.Timeout | null = null;
  private cfg: MatrixRainConfig;
  private cols: Column[] = [];
  private pending: TrailChar[] = [];
  private pIdx = 0;
  private outputCol = 0;  // adjacent placement cursor for output type
  private active = false;

  private static readonly TICK_MS = 45;
  private static readonly TRAIL_MIN = 8;
  private static readonly TRAIL_MAX = 25;
  private static readonly GAP_MIN = 3;
  private static readonly GAP_MAX = 20;
  private static readonly SPEED_MIN = 1;
  private static readonly SPEED_MAX = 4;
  private static readonly SPEED_SLOW_MIN = 4;  // output type — slower = more readable
  private static readonly SPEED_SLOW_MAX = 7;

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
      trail: [], pos: -1,
      speed: MatrixRainController.SPEED_MIN +
        Math.floor(Math.random() * MatrixRainController.SPEED_MAX),
      tick: 0, phase: 'gap',
      gapTimer: Math.floor(Math.random() * MatrixRainController.GAP_MAX),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.active = true;
    this.dispatchAmbient();
    this.timer = setInterval(() => this.tick(), MatrixRainController.TICK_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cols = []; this.pending = []; this.active = false;
  }

  setActive(a: boolean): void { this.active = a; }

  resize(w: number, h: number, row: number): void {
    this.cfg = { width: w, height: h, terminalRow: row };
    const old = this.cols;
    this.cols = [];
    for (let c = 0; c < w; c++) {
      this.cols.push(c < old.length ? old[c] : this.newColumn());
    }
  }

  // ── Feed (with type for color) ────────────────────────────────────────

  feed(text: string, type: RainType = 'thinking'): void {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 32 || cp === 127) continue;
      this.pending.push({ ch, type });
    }
    if (this.pending.length > 5000) {
      this.pending = this.pending.slice(-3000);
    }
  }

  // ── Content source ────────────────────────────────────────────────────

  private nextChar(): TrailChar | null {
    if (this.pending.length === 0) return null;
    const tc = this.pending[this.pIdx % this.pending.length];
    this.pIdx = (this.pIdx + 1) % this.pending.length;
    return tc;
  }

  private buildTrail(len: number): TrailChar[] {
    const t: TrailChar[] = [];
    for (let i = 0; i < len; i++) {
      t.push(this.nextChar() ?? { ch: ' ', type: 'thinking' });
    }
    return t;
  }

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
    for (let ci = 0; ci < this.cols.length; ci++) {
      const col = this.cols[ci];
      col.tick++;
      if (col.tick < col.speed) continue;
      col.tick = 0;
      if (col.phase === 'drop') {
        col.pos++;
        if (col.pos >= height) {
          col.trail = [];
          col.phase = 'gap';
          col.gapTimer = MatrixRainController.GAP_MIN +
            Math.floor(Math.random() * MatrixRainController.GAP_MAX);
        }
      } else {
        col.gapTimer--;
        if (col.gapTimer <= 0) {
          const len = MatrixRainController.TRAIL_MIN +
            Math.floor(Math.random() * (MatrixRainController.TRAIL_MAX - MatrixRainController.TRAIL_MIN));
          col.trail = this.buildTrail(len);
          col.pos = -len;
          col.phase = 'drop';
          // Output type: slower speed + adjacent columns for readability
          if (col.trail.length > 0 && col.trail[0]?.type === 'output') {
            col.speed = MatrixRainController.SPEED_SLOW_MIN +
              Math.floor(Math.random() * (MatrixRainController.SPEED_SLOW_MAX - MatrixRainController.SPEED_SLOW_MIN));
            // Move this column's trail to the output cursor position
            const targetCol = this.outputCol;
            this.outputCol = (this.outputCol + 1) % this.cfg.width;
            if (targetCol !== ci) {
              this.cols[targetCol].trail = col.trail;
              this.cols[targetCol].pos = col.pos;
              this.cols[targetCol].phase = 'drop';
              this.cols[targetCol].speed = col.speed;
              this.cols[targetCol].tick = 0;
              col.trail = [];
              col.phase = 'gap';
              col.gapTimer = 1;
            }
          }
        }
      }
    }
    this.renderFrame();
  }

  // ── Render ────────────────────────────────────────────────────────────

  private renderFrame(): void {
    const { width, height, terminalRow } = this.cfg;
    if (width <= 0 || height <= 0) return;

    const grid: Array<Array<{ ch: string; type: RainType; b: number } | null>> =
      Array.from({ length: height }, () => Array(width).fill(null));

    for (let c = 0; c < width; c++) {
      const col = this.cols[c];
      if (col.phase !== 'drop' || col.trail.length === 0) continue;
      for (let i = 0; i < col.trail.length; i++) {
        const row = col.pos + i;
        if (row >= 0 && row < height) {
          const tc = col.trail[i];
          if (tc.ch === ' ') continue;
          if (!grid[row][c]) {
            // Ratio-based brightness: 1.0=head, 0.0=tail. Works for any trail length.
            const ratio = col.trail.length > 1
              ? (col.trail.length - i) / col.trail.length
              : 1;
            grid[row][c] = { ch: tc.ch, type: tc.type, b: ratio };
          }
        }
      }
    }

    const lines: string[] = [];
    for (let r = 0; r < height; r++) {
      let line = '';
      let cur = -1; // 0=none, 1=head, 2=bright, 3=normal, 4=dim
      for (let c = 0; c < width; c++) {
        const cell = grid[r][c];
        if (cell) {
          const [bright, normal, dim] = PALETTE[cell.type] || PALETTE.thinking;
          let s: number;
          let color: string;
          // Ratio-based: works for any trail length
          if (cell.b > 0.85)         { s = 1; color = WH; }      // head — top 15%
          else if (cell.b > 0.5)    { s = 2; color = bright; }   // bright — upper half
          else if (cell.b > 0.2)    { s = 3; color = normal; }   // normal — mid
          else                       { s = 4; color = dim; }      // dim — tail

          if (s !== cur) { line += R + color; cur = s; }
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
