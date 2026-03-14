import { spawn } from "child_process";
import { runInSandbox, SandboxResult } from "./docker-sandbox.js";
import { withRetry, isTransientError } from "./retry.js";
import { config as appConfig } from "../config/loader.js";



export interface ExecutorConfig {
  timeoutMs?: number;
  useSandbox?: boolean;
  maxRetries?: number;
  workDir?: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  attempts: number;
}

export function createExecutor(config: ExecutorConfig = {}) {
  const {
    timeoutMs = appConfig.executor.timeout_ms,
    useSandbox = true,
    maxRetries = appConfig.executor.max_retries,
    workDir
  } = config;

  return {
    async run(command: string): Promise<ExecutionResult> {
      let attempts = 0;

      const execute = async (): Promise<ExecutionResult> => {
        attempts++;

        if (useSandbox) {
          try {
            const result = await runInSandbox(command, {
              timeout: timeoutMs,
              workDir: workDir || "/workspace",
            });
            // Treat non-zero exit from dockerode run as error to trigger retry
            if (result.timedOut || result.exitCode > 128) {
              throw Object.assign(new Error("Container failed"), { killed: result.timedOut, code: result.exitCode });
            }
            return { ...result, attempts };
          } catch (err: any) {
            // If Docker failed completely (transient), we throw to retry
            if (isTransientError(err)) throw err;
            // Otherwise throw error, DO NOT fallback silently
            throw new Error(`Sandbox unavailable or failed: ${err.message}. Sandbox execution is strictly required unless explicitly disabled.`);
          }
        }

        console.warn(`\n[executor] WARNING: Running command directly on your local machine: ${command}\n`);
        return runLocal(command, timeoutMs, attempts, workDir);
      };

      return withRetry(execute, { maxAttempts: maxRetries }, (err, _attempt) => {
        return isTransientError(err);
      });
    },

    async runLocal(command: string): Promise<ExecutionResult> {
      return runLocal(command, timeoutMs, 1, workDir);
    },
  };
}

async function runLocal(command: string, timeoutMs: number, attempts: number, workDir?: string): Promise<ExecutionResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, {
      shell: true,
      cwd: workDir || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: Date.now() - startTime,
        attempts,
      });
    });

    child.on("error", (err: any) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: (stderr + "\n" + err.message).trim(),
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        attempts,
      });
    });
  });
}
