import { getScreenManager } from './screenManager';

const ESC = '\x1b';

export interface TUIInputResult {
  content: string;
  shouldProcess: boolean;
  shouldExit: boolean;
  isInterrupt: boolean;
}

export class TUIInputHandler {
  private screen = getScreenManager();
  private lastEscTime: number = 0;
  private interruptCount: number = 0;

  getScreen() {
    return this.screen;
  }

  start(): void {
    this.screen.start();
  }
  end(): void {
    this.screen.end();
  }

  handleStdin(data: string, permissionDialogActive: boolean): TUIInputResult {
    if (permissionDialogActive) {
      return { content: '', shouldProcess: false, shouldExit: false, isInterrupt: false };
    }

    if (data === '\x03') {
      // Ctrl+C 在 TUI 模式下也触发中断
      return { content: '', shouldProcess: false, shouldExit: false, isInterrupt: true };
    }

    if (data === ESC) {
      const now = Date.now();
      if (now - this.lastEscTime < 500) {
        this.lastEscTime = 0;
        return { content: '', shouldProcess: false, shouldExit: false, isInterrupt: true };
      }
      this.lastEscTime = now;
      return { content: '', shouldProcess: false, shouldExit: false, isInterrupt: false };
    }

    const shouldSend = this.screen.handleInput(data);
    if (shouldSend) {
      const content = this.screen.getContent();
      this.screen.clear();
      return { content, shouldProcess: true, shouldExit: false, isInterrupt: false };
    }
    return { content: '', shouldProcess: false, shouldExit: false, isInterrupt: false };
  }
}
