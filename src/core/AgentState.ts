/**
 * Unified agent state machine — replaces scattered booleans.
 *
 * Previous approach: _initialized, _compacting, pendingCancel, _initPromise
 * were independent booleans. Invalid combinations (e.g., compacting + uninitialized)
 * were not prevented by the type system.
 *
 * Explicit states with validated transitions. All invalid transitions throw
 * in development and warn in production.
 */

export type AgentState =
  | 'uninitialized'
  | 'initializing'
  | 'idle'
  | 'processing'
  | 'compacting'
  | 'interrupted';

/** Valid state transitions. Format: from → Set<to> */
const VALID_TRANSITIONS: Readonly<Record<AgentState, ReadonlySet<AgentState>>> = {
  uninitialized: new Set(['initializing']),
  initializing: new Set(['idle', 'uninitialized']),
  idle: new Set(['processing', 'compacting', 'uninitialized']),
  processing: new Set(['idle', 'interrupted', 'compacting']),
  compacting: new Set(['idle', 'processing']),
  interrupted: new Set(['idle', 'processing']),
};

/** Human-readable labels for each state. */
export const STATE_LABELS: Readonly<Record<AgentState, string>> = {
  uninitialized: 'Not initialized',
  initializing: 'Initializing…',
  idle: 'Ready',
  processing: 'Processing',
  compacting: 'Compressing context',
  interrupted: 'Interrupted',
};

export class AgentStateMachine {
  private _state: AgentState = 'uninitialized';
  private _transitionLog: Array<{ from: AgentState; to: AgentState; at: string }> = [];
  private _maxLogSize: number;

  constructor(maxLogSize = 50) {
    this._maxLogSize = maxLogSize;
  }

  get current(): AgentState {
    return this._state;
  }

  /** Whether the agent can accept user input in this state. */
  get canAcceptInput(): boolean {
    return this._state === 'idle' || this._state === 'interrupted';
  }

  /** Whether the agent is doing work (processing or compacting). */
  get isBusy(): boolean {
    return this._state === 'processing' || this._state === 'compacting';
  }

  /** Whether initialization is complete. */
  get isReady(): boolean {
    return this._state !== 'uninitialized' && this._state !== 'initializing';
  }

  /**
   * Attempt a state transition. Throws in development on invalid transitions.
   * Returns true if the transition was accepted.
   */
  transition(to: AgentState): boolean {
    const from = this._state;
    if (from === to) return true; // no-op

    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.has(to)) {
      const msg = `Invalid state transition: ${from} → ${to}`;
      if (process.env.NODE_ENV === 'development' || process.env.SPICA_STRICT) {
        throw new Error(msg);
      }
      console.warn(`[AgentState] ${msg} (ignored in production)`);
      return false;
    }

    this._state = to;
    this._transitionLog.push({ from, to, at: new Date().toISOString() });
    while (this._transitionLog.length > this._maxLogSize) {
      this._transitionLog.shift();
    }
    return true;
  }

  /** Force a state transition (skip validation). Use only for recovery. */
  forceTransition(to: AgentState): void {
    const from = this._state;
    this._state = to;
    this._transitionLog.push({ from, to, at: new Date().toISOString() });
  }

  /** Get the transition history for debugging. */
  getTransitionLog(): ReadonlyArray<{ from: AgentState; to: AgentState; at: string }> {
    return this._transitionLog;
  }

  /** Reset to initial state. */
  reset(): void {
    this._state = 'uninitialized';
    this._transitionLog = [];
  }
}
