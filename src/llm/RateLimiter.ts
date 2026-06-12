export interface RateLimitConfig {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export class RateLimiter {
  private requestTimestamps: number[] = [];
  private tokenUsage: { timestamp: number; tokens: number }[] = [];
  private config: RateLimitConfig;
  private pendingInterrupt = false;

  constructor(config: RateLimitConfig = {}) {
    this.config = {
      requestsPerMinute: config.requestsPerMinute || 500,
      tokensPerMinute: config.tokensPerMinute || 100000,
    };
  }

  // 设置中断标记（外部调用）
  interrupt(): void {
    this.pendingInterrupt = true;
  }

  async waitForAvailability(signal?: AbortSignal): Promise<void> {
    if (this.pendingInterrupt) {
      this.pendingInterrupt = false;
      return;
    }

    let now = Date.now();
    const minuteAgo = now - 60000;

    this.requestTimestamps = this.requestTimestamps.filter(t => t > minuteAgo);
    this.tokenUsage = this.tokenUsage.filter(u => u.timestamp > minuteAgo);

    // 等待请求限制
    while (this.requestTimestamps.length >= this.config.requestsPerMinute!) {
      if (signal?.aborted || this.pendingInterrupt) {
        this.pendingInterrupt = false;
        return;
      }

      const oldest = this.requestTimestamps[0];
      const waitTime = oldest + 60000 - now + 100;
      await this.interruptibleSleep(waitTime, signal);

      if (this.pendingInterrupt) {
        this.pendingInterrupt = false;
        return;
      }

      now = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(t => t > now - 60000);
    }

    // 等待token限制
    const totalTokens = this.tokenUsage.reduce((sum, u) => sum + u.tokens, 0);
    if (totalTokens >= this.config.tokensPerMinute!) {
      if (signal?.aborted || this.pendingInterrupt) {
        this.pendingInterrupt = false;
        return;
      }

      const oldestToken = this.tokenUsage[0];
      const waitTime = oldestToken.timestamp + 60000 - now + 100;
      await this.interruptibleSleep(waitTime, signal);
      this.tokenUsage = this.tokenUsage.filter(u => u.timestamp > Date.now() - 60000);
    }
  }

  recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  recordTokenUsage(tokens: number): void {
    this.tokenUsage.push({ timestamp: Date.now(), tokens });
  }

  getStatus(): { requestsRemaining: number; tokensRemaining: number } {
    const now = Date.now();
    const minuteAgo = now - 60000;

    const recentRequests = this.requestTimestamps.filter(t => t > minuteAgo).length;
    const recentTokens = this.tokenUsage
      .filter(u => u.timestamp > minuteAgo)
      .reduce((sum, u) => sum + u.tokens, 0);

    return {
      requestsRemaining: this.config.requestsPerMinute! - recentRequests,
      tokensRemaining: this.config.tokensPerMinute! - recentTokens,
    };
  }

  // 可中断的sleep
  private interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, _reject) => {
      if (signal?.aborted || this.pendingInterrupt) {
        resolve();
        return;
      }

      let timer: NodeJS.Timeout | null = null;
      let checkInterval: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (checkInterval) clearInterval(checkInterval);
      };

      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      if (signal) {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          cleanup();
          resolve();
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort);
        }
      }

      // 也检查pendingInterrupt
      checkInterval = setInterval(() => {
        if (this.pendingInterrupt) {
          cleanup();
          resolve();
        }
      }, 100);
    });
  }
}
