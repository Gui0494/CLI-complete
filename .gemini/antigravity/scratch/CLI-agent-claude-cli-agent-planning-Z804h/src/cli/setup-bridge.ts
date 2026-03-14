import * as readline from "readline";
import chalk from "chalk";
import { PythonBridge } from "../bridge/python-bridge.js";
import { createExecutor, ExecutorConfig } from "../executor/runner.js";
import { readFile, writeFile } from "../editor/file-ops.js";
import * as diff from "diff";

export function setupBridgeHandlers(bridge: PythonBridge, rl?: readline.Interface, executorOptions?: ExecutorConfig) {
    const executor = createExecutor(executorOptions || {});

    const ask = (q: string): Promise<string> => {
        return new Promise((resolve) => {
            if (process.env.AUREX_AUTO_YES === "1") {
                console.log(q + "y (auto)");
                return resolve("y");
            }
            if (rl) {
                rl.question(q, (ans) => {
                    setTimeout(() => resolve(ans), 0);
                });
            } else {
                const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
                tempRl.question(q, (ans) => {
                    tempRl.close();
                    setTimeout(() => resolve(ans), 0);
                });
            }
        });
    };

    bridge.on("request", async (req: any) => {
        if (req.method === "permission_request") {
            bridge.emit("pause_spinner");
            const { action, risk_level, reason } = req.params;
            const color = risk_level === "critical" ? chalk.red : (risk_level === "high" ? chalk.redBright : chalk.yellow);

            console.log(`\n${color(`⚠ CONFIRMAÇÃO NECESSÁRIA [${risk_level.toUpperCase()}]`)}`);
            console.log(`  Ação: ${action}`);
            console.log(`  Risco: ${reason}`);

            const answer = await ask(`  Permitir? [y/N]: `);
            const allowed = ["y", "yes", "s", "sim"].includes(answer.trim().toLowerCase());
            bridge.sendResponse(req.id, { allowed });
            bridge.emit("resume_spinner");
        } else if (req.method === "run_node_tool") {
            const { tool_name, tool_args } = req.params;
            bridge.emit("pause_spinner");
            try {
                let result;
                if (tool_name === "exec_command") {
                    try {
                        const runRes = await executor.run(tool_args.cmd);
                        let finalStderr = runRes.stderr;
                        if (runRes.exitCode !== 0 || runRes.timedOut) {
                            const { classifyError } = await import("../executor/retry.js");
                            const errClass = classifyError({ stderr: runRes.stderr, code: runRes.exitCode, timedOut: runRes.timedOut });
                            if (errClass !== "UNKNOWN") {
                                finalStderr = `[ErrorClass: ${errClass}]\n${runRes.stderr}`;
                            }
                        }
                        result = { ok: runRes.exitCode === 0, stdout: runRes.stdout, stderr: finalStderr, exit_code: runRes.exitCode };
                    } catch (cmdErr: any) {
                        const { classifyError } = await import("../executor/retry.js");
                        const errClass = classifyError(cmdErr);
                        result = { ok: false, stdout: "", stderr: `[ErrorClass: ${errClass}]\n${cmdErr.message}`, exit_code: -1 };
                    }
                } else if (tool_name === "read_file") {
                    const content = await readFile(tool_args.path);
                    result = { ok: true, content: content.slice(0, 50000), truncated: content.length > 50000 };
                } else if (tool_name === "list_files") {
                    const { listFiles } = await import("../editor/file-ops.js");
                    const files = await listFiles(tool_args.dir || ".");
                    result = { ok: true, files: files.slice(0, 500), truncated: files.length > 500 };
                } else if (tool_name === "edit_file") {
                    const filePath = tool_args.path;
                    const oldText = tool_args.old_text;
                    const newText = tool_args.new_text;
                    const content = await readFile(filePath);
                    if (!content.includes(oldText)) {
                        result = { ok: false, error: "old_text not found in file. Ensure it is an exact match including whitespace." };
                    } else {
                        const occurrences = content.split(oldText).length - 1;
                        if (occurrences > 1 && !tool_args.replace_all) {
                            result = { ok: false, error: `old_text found ${occurrences} times. Provide more context to make it unique, or set replace_all: true.` };
                        } else {
                            const updated = tool_args.replace_all ? content.split(oldText).join(newText) : content.replace(oldText, newText);

                            const diffLines = diff.diffLines(content, updated);
                            let additions = 0, deletions = 0;
                            diffLines.forEach((part: any) => {
                                const lines = part.value.split('\n').filter((l: string) => l.length > 0).length;
                                if (part.added) additions += lines;
                                if (part.removed) deletions += lines;
                            });

                            console.log(`\n${chalk.cyan(`📄 Patch ready for ${filePath}`)} ${chalk.green(`+${additions}`)} ${chalk.red(`-${deletions}`)}`);

                            let allowed = false;
                            while (true) {
                                const answer = await ask(`  [a] apply   [d] view diff   [x] cancel: `);
                                const cmd = answer.trim().toLowerCase();

                                if (cmd === "a" || cmd === "y" || cmd === "yes") {
                                    allowed = true;
                                    break;
                                } else if (cmd === "x" || cmd === "n" || cmd === "no") {
                                    allowed = false;
                                    break;
                                } else if (cmd === "d" || cmd === "v") {
                                    console.log(`\n${chalk.cyan(`📄 Diff:`)}`);
                                    diffLines.forEach((part: any) => {
                                        const color = part.added ? chalk.green : part.removed ? chalk.red : chalk.gray;
                                        const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
                                        const lines = part.value.split('\n');
                                        if (lines[lines.length - 1] === '') lines.pop();
                                        lines.forEach((line: string) => console.log(color(prefix + line)));
                                    });
                                    console.log();
                                }
                            }

                            if (!allowed) {
                                result = { ok: false, error: "User rejected the patch" };
                            } else {
                                await writeFile(filePath, updated);
                                result = { ok: true, message: `Edited ${filePath}`, replacements: tool_args.replace_all ? occurrences : 1 };
                            }
                        }
                    }
                } else if (tool_name === "write_file") {
                    let content = "";
                    try { content = await readFile(tool_args.path); } catch (e) { } // file might not exist

                    const diffLines = diff.diffLines(content, tool_args.content);
                    let additions = 0, deletions = 0;
                    diffLines.forEach((part: any) => {
                        const lines = part.value.split('\n').filter((l: string) => l.length > 0).length;
                        if (part.added) additions += lines;
                        if (part.removed) deletions += lines;
                    });

                    console.log(`\n${chalk.cyan(`📄 File write ready for ${tool_args.path}`)} ${chalk.green(`+${additions}`)} ${chalk.red(`-${deletions}`)}`);

                    let allowed = false;
                    while (true) {
                        const answer = await ask(`  [a] apply   [d] view diff   [x] cancel: `);
                        const cmd = answer.trim().toLowerCase();

                        if (cmd === "a" || cmd === "y" || cmd === "yes") {
                            allowed = true;
                            break;
                        } else if (cmd === "x" || cmd === "n" || cmd === "no") {
                            allowed = false;
                            break;
                        } else if (cmd === "d" || cmd === "v") {
                            console.log(`\n${chalk.cyan(`📄 Diff:`)}`);
                            diffLines.forEach((part: any) => {
                                const color = part.added ? chalk.green : part.removed ? chalk.red : chalk.gray;
                                const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
                                const lines = part.value.split('\n');
                                if (lines[lines.length - 1] === '') lines.pop();
                                if (part.added || part.removed || lines.length <= 10) {
                                    lines.forEach((line: string) => console.log(color(prefix + line)));
                                } else {
                                    lines.slice(0, 3).forEach((line: string) => console.log(color(prefix + line)));
                                    console.log(chalk.gray("  ..."));
                                    lines.slice(-3).forEach((line: string) => console.log(color(prefix + line)));
                                }
                            });
                            console.log();
                        }
                    }

                    if (!allowed) {
                        result = { ok: false, error: "User rejected the file write" };
                    } else {
                        await writeFile(tool_args.path, tool_args.content);
                        result = { ok: true, message: `Created/Overwritten ${tool_args.path}` };
                    }
                } else if (tool_name === "grep") {
                    const { execSync } = await import("child_process");
                    try {
                        const grepCmd = process.platform === "win32"
                            ? `findstr /s /n /c:"${tool_args.pattern.replace(/"/g, '\\"')}" ${tool_args.path || "*.*"}`
                            : `grep -rn "${tool_args.pattern.replace(/"/g, '\\"')}" ${tool_args.path || "."}`;
                        const output = execSync(grepCmd, { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10000 });
                        result = { ok: true, matches: output.slice(0, 30000), truncated: output.length > 30000 };
                    } catch (e: any) {
                        if (e.status === 1) {
                            result = { ok: true, matches: "", message: "No matches found" };
                        } else {
                            result = { ok: false, error: e.message };
                        }
                    }
                } else {
                    throw new Error(`Unknown node tool: ${tool_name}`);
                }
                bridge.sendResponse(req.id, result);
            } catch (err: any) {
                bridge.sendResponse(req.id, null, { code: -32000, message: err.message });
            } finally {
                bridge.emit("resume_spinner");
            }
        }
    });
}
