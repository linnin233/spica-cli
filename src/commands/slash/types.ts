import type { SpicaAgent } from '../../agent';
import type { ScreenManager } from '../../cli/ui/screenManager';
import type { TokenCounter } from '../../llm/TokenCounter';
import type { getRuntimeState } from '../../core/RuntimeState';

export interface SlashContext {
  agent: SpicaAgent;
  screen: ScreenManager;
  state: ReturnType<typeof getRuntimeState>;
  tokenCounter: TokenCounter;
  isProcessing: boolean;
  setProcessing: (v: boolean) => void;
  providerConfig: { model: string };
  updateStatusBar: () => void;
  handleInput: (line: string) => Promise<void>;
}

export type SlashHandler = (args: string, ctx: SlashContext) => Promise<void>;
