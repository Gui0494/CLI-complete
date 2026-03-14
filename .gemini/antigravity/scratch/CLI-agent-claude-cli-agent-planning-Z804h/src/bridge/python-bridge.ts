import { spawn, ChildProcess } from "child_process";
import { createRequest, parseResponse, JsonRpcResponse } from "./protocol.js";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export class PythonBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";

  async start(): Promise<void> {
    if (this.process) return;

    const pythonDir = path.resolve(__dirname, "../../python");
    const pythonCmd = os.platform() === "win32" ? "python" : "python3";

    this.process = spawn(pythonCmd, ["-m", "aurex.main"], {
      cwd: pythonDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[python-stderr] ${msg}`);
    });

    this.process.on("exit", (code) => {
      this.abortAll(new Error(`Python process exited with code ${code}`));
      this.process = null;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => cleanup(new Error("Python bridge timeout")), 10000);

      const cleanup = (err?: Error) => {
        clearTimeout(timeout);
        this.process?.stdout?.off("data", onReadyData);
        this.process?.off("error", onError);
        if (err) reject(err);
      };

      const onError = (err: Error) => cleanup(err);

      const onReadyData = (data: Buffer) => {
        this.buffer += data.toString("utf8");

        let newlineIdx = this.buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = this.buffer.slice(0, newlineIdx).trim();
          this.buffer = this.buffer.slice(newlineIdx + 1);

          if (!line) {
            newlineIdx = this.buffer.indexOf("\n");
            continue;
          }

          try {
            const parsed = JSON.parse(line);
            if (parsed?.ready === true) {
              clearTimeout(timeout);
              this.process!.stdout!.off("data", onReadyData);
              this.process!.stdout!.on("data", (d: Buffer) => {
                this.buffer += d.toString("utf8");
                this.processBuffer();
              });
              this.process!.off("error", onError);
              resolve();
              return;
            }

            console.error(`[python-stdout-preinit] ${line}`);
          } catch {
            console.error(`[python-stdout-preinit] ${line}`);
          }

          newlineIdx = this.buffer.indexOf("\n");
        }
      };

      this.process!.on("error", onError);
      this.process!.stdout!.on("data", onReadyData);
    });

    process.on("SIGINT", this.handleSigint);
  }

  private handleSigint = () => {
    this.abortAll(new Error("User interrupted operation"));
    this.stop();
  }

  private abortAll(error: Error) {
    for (const [, handler] of this.pending) {
      handler.reject(error);
    }
    this.pending.clear();
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<any> {
    if (!this.process) throw new Error("Python bridge not started");

    const id = ++this.requestId;
    const request = createRequest(method, params, id);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Python bridge request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.process!.stdin!.write(request, (err) => {
        if (!err) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  stop(): void {
    process.off("SIGINT", this.handleSigint);
    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process) this.process.kill("SIGKILL");
      }, 2000);
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = parseResponse(trimmed);

        // Handle requests from Python to Node
        if (response.id !== undefined && response.method !== undefined) {
          this.emit("request", {
            method: response.method,
            params: response.params,
            id: response.id
          });
          continue;
        }

        // Handle notifications (no id)
        if (response.id === undefined) {
          if (response.method) {
            this.emit(response.method, response.params);
          }
          continue;
        }

        // Handle standard responses
        const handler = this.pending.get(response.id);
        if (handler) {
          this.pending.delete(response.id);
          if (response.error) {
            handler.reject(new Error(response.error.message));
          } else {
            handler.resolve(response.result);
          }
        }
      } catch (e) {
        // Not JSON, probably a print() statement from Python
        console.error(`[python-stdout] ${trimmed}`);
      }
    }
  }

  sendResponse(id: number, result?: any, error?: any): void {
    if (!this.process) return;
    const resp: any = { jsonrpc: "2.0", id };
    if (error) {
      resp.error = error;
    } else {
      resp.result = result !== undefined ? result : null;
    }
    this.process.stdin!.write(JSON.stringify(resp) + "\n");
  }
}

