// Runtime state management - Unified state for CLI session

import type { SpicaAgent } from '../agent';

interface ProviderConfig {
  provider?: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  name?: string;
  rateLimit?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };
}

interface RuntimeState {
  // Agent
  agent: SpicaAgent | null;
  providerConfig: ProviderConfig | null;

  // Processing state
  isProcessing: boolean;
  streamingOutput: boolean;

  // UI state
  connectionErrorShown: boolean;
  /** Display mode: compact (spinner only) | verbose (full reasoning text) | hacker (matrix rain) */
  displayMode: 'compact' | 'verbose' | 'hacker';
  showThinking: boolean;

  // Git branch (for status bar display, null when no repo)
  currentBranch: string | null;

  // Interrupt state
  interruptCount: number;
  lastInterruptTime: number;
  shouldExit: boolean;
  /** Set when agent is interrupted — prevents buffered stream chunks from displaying after interrupt */
  interrupted: boolean;
}

/**
 * RuntimeState - Unified state management for CLI session
 *
 * Manages:
 * - Agent instance
 * - Provider configuration
 * - Processing state (isProcessing)
 * - UI state (verbose, showThinking)
 * - Interrupt state (count, shouldExit)
 *
 * Singleton pattern - use getRuntimeState() to access
 *
 * @example
 * ```ts
 * const state = getRuntimeState();
 * state.setProcessing(true);
 * if (state.isProcessing()) {
 *   // handle processing state
 * }
 * ```
 */
class RuntimeStateManager {
  private state: RuntimeState = {
    agent: null,
    providerConfig: null,
    isProcessing: false,
    streamingOutput: false,
    connectionErrorShown: false,
    displayMode: 'compact',
    showThinking: false,
    currentBranch: null,
    interruptCount: 0,
    lastInterruptTime: 0,
    shouldExit: false,
    interrupted: false,
  };

  // Agent
  setAgent(agent: SpicaAgent | null): void {
    this.state.agent = agent;
  }

  getAgent(): SpicaAgent | null {
    return this.state.agent;
  }

  // Provider Config
  setProviderConfig(config: ProviderConfig | null): void {
    this.state.providerConfig = config;
  }

  getProviderConfig(): ProviderConfig | null {
    return this.state.providerConfig;
  }

  get model(): string {
    return this.state.providerConfig?.model || '';
  }

  // Processing
  setProcessing(isProcessing: boolean): void {
    this.state.isProcessing = isProcessing;
  }

  isProcessing(): boolean {
    return this.state.isProcessing;
  }

  // Streaming Output
  setStreamingOutput(streaming: boolean): void {
    this.state.streamingOutput = streaming;
  }

  isStreamingOutput(): boolean {
    return this.state.streamingOutput;
  }

  // Connection Error
  setConnectionErrorShown(shown: boolean): void {
    this.state.connectionErrorShown = shown;
  }

  isConnectionErrorShown(): boolean {
    return this.state.connectionErrorShown;
  }

  // Display Mode (compact / verbose / hacker)
  getDisplayMode(): 'compact' | 'verbose' | 'hacker' {
    return this.state.displayMode;
  }

  setDisplayMode(mode: 'compact' | 'verbose' | 'hacker'): void {
    this.state.displayMode = mode;
  }

  cycleDisplayMode(): 'compact' | 'verbose' | 'hacker' {
    const order: Array<'compact' | 'verbose' | 'hacker'> = ['compact', 'verbose', 'hacker'];
    const idx = order.indexOf(this.state.displayMode);
    this.state.displayMode = order[(idx + 1) % 3];
    return this.state.displayMode;
  }

  // Backward-compatible API (legacy callers)
  /** @deprecated Use getDisplayMode() === 'verbose' */
  isVerboseMode(): boolean {
    return this.state.displayMode !== 'compact';
  }

  /** @deprecated Use setDisplayMode() */
  setVerboseMode(verbose: boolean): void {
    this.state.displayMode = verbose ? 'verbose' : 'compact';
  }

  /** @deprecated Use cycleDisplayMode() */
  toggleVerboseMode(): boolean {
    return this.cycleDisplayMode() !== 'compact';
  }

  // Thinking display mode (Ctrl+O toggle)
  setShowThinking(show: boolean): void {
    this.state.showThinking = show;
  }

  isShowThinking(): boolean {
    return this.state.showThinking;
  }

  toggleShowThinking(): boolean {
    this.state.showThinking = !this.state.showThinking;
    return this.state.showThinking;
  }

  // Git branch
  setCurrentBranch(branch: string | null): void {
    this.state.currentBranch = branch;
  }

  getCurrentBranch(): string | null {
    return this.state.currentBranch;
  }

  // Interrupt handling
  recordInterrupt(): void {
    const now = Date.now();
    if (now - this.state.lastInterruptTime < 1000) {
      this.state.interruptCount++;
    } else {
      this.state.interruptCount = 1;
    }
    this.state.lastInterruptTime = now;
  }

  getInterruptCount(): number {
    return this.state.interruptCount;
  }

  resetInterruptCount(): void {
    this.state.interruptCount = 0;
  }

  // Interrupted flag — prevents buffered stream chunks from displaying after ESC ESC
  setInterrupted(value: boolean): void {
    this.state.interrupted = value;
  }

  isInterrupted(): boolean {
    return this.state.interrupted;
  }

  // Exit flag
  setShouldExit(exit: boolean): void {
    this.state.shouldExit = exit;
  }

  shouldExit(): boolean {
    return this.state.shouldExit;
  }

  // Interrupt agent
  interrupt(): void {
    if (this.state.agent) {
      this.state.agent.interrupt();
    }
  }

  // Reset all state
  reset(): void {
    this.state = {
      agent: null,
      providerConfig: null,
      isProcessing: false,
      streamingOutput: false,
      connectionErrorShown: false,
      displayMode: 'compact',
      showThinking: false,
      currentBranch: null,
      interruptCount: 0,
      lastInterruptTime: 0,
      shouldExit: false,
      interrupted: false,
    };
  }
}

let instance: RuntimeStateManager | null = null;

/**
 * Get the singleton RuntimeState instance
 * @returns RuntimeStateManager instance
 */
export function getRuntimeState(): RuntimeStateManager {
  if (!instance) instance = new RuntimeStateManager();
  return instance;
}

/**
 * Reset runtime state to initial values
 * Clears agent, provider config, and all state flags
 */
export function resetRuntimeState(): void {
  if (instance) instance.reset();
}
