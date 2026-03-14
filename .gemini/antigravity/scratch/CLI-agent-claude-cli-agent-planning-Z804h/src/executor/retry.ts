export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors?: string[];
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  shouldRetry?: (error: Error, attempt: number) => boolean
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...config };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      if (attempt >= cfg.maxAttempts) break;

      if (shouldRetry && !shouldRetry(err, attempt)) break;

      // Check if error is retryable
      if (cfg.retryableErrors && cfg.retryableErrors.length > 0) {
        const isRetryable = cfg.retryableErrors.some(
          (pattern) => err.message?.includes(pattern) || err.code === pattern
        );
        if (!isRetryable) break;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        cfg.maxDelayMs
      );
      await sleep(delay);
    }
  }

  throw lastError || new Error("All retry attempts failed");
}

export type ErrorClass = "TIMEOUT" | "NETWORK" | "PERMISSION" | "CONFLICT" | "NOT_FOUND" | "SYNTAX" | "UNKNOWN";

export function classifyError(err: any): ErrorClass {
  if (!err) return "UNKNOWN";

  const msg = (err.message || "").toLowerCase();
  const stderrMsg = (err.stderr || "").toLowerCase();
  const code = err.code;

  if (err.killed === true || err.timedOut === true || msg.includes("timeout") || code === "ETIMEDOUT") {
    return "TIMEOUT";
  }

  if (code === "ECONNRESET" || code === "ECONNREFUSED" || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("network")) {
    return "NETWORK";
  }

  if (msg.includes("permission denied") || stderrMsg.includes("permission denied") || code === "EACCES" || code === "EPERM" || msg.includes("401") || msg.includes("403")) {
    return "PERMISSION";
  }

  if (msg.includes("conflict") || msg.includes("409")) {
    return "CONFLICT";
  }

  if (msg.includes("enoent") || msg.includes("not found") || stderrMsg.includes("not found") || code === "ENOENT" || msg.includes("404")) {
    return "NOT_FOUND";
  }

  if (msg.includes("syntax error") || stderrMsg.includes("syntax error") || code === "SYNTAX") {
    return "SYNTAX";
  }

  return "UNKNOWN";
}

export function isTransientError(err: any): boolean {
  if (!err) return false;

  const errClass = classifyError(err);
  if (errClass === "NETWORK") return true;

  // Docker specific transient states
  const msg = (err.message || "").toLowerCase();
  if (msg.includes("container not running") || msg.includes("dead")) return true;

  // Timeouts are final if they correspond to execution limits
  if (errClass === "TIMEOUT" && (err.killed || err.timedOut)) return false;
  if (errClass === "TIMEOUT") return true;

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
