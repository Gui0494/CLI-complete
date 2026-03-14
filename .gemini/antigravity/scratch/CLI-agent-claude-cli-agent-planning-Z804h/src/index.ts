#!/usr/bin/env node

import { config } from "dotenv";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { startRepl } from "./cli/repl.js";
import { createExecutor } from "./executor/runner.js";
import { createVerifier } from "./verifier/test-runner.js";
import { createRepoAgent } from "./repo-agent/github.js";
import { PythonBridge } from "./bridge/python-bridge.js";
import { setupBridgeHandlers } from "./cli/setup-bridge.js";

config();

const program = new Command();

program
  .name("aurex")
  .description("AurexAI - Local CLI Agent for code editing, web search, planning, and execution")
  .version("0.1.0");

program
  .command("interactive")
  .alias("i")
  .description("Start interactive REPL mode")
  .action(async () => {
    await startRepl();
  });

program
  .command("exec <command...>")
  .description("Run a command securely via Python PermissionManager")
  .option("-t, --timeout <ms>", "Timeout in milliseconds", "60000")
  .option("--no-sandbox", "Run without Docker (use with caution)")
  .action(async (commandParts: string[], opts) => {
    const bridge = new PythonBridge();
    setupBridgeHandlers(bridge, undefined, {
      timeoutMs: parseInt(opts.timeout),
      useSandbox: opts.sandbox,
    });
    try {
      const timeoutMs = parseInt(opts.timeout);

      const execPromise = async () => {
        await bridge.start();
        return await bridge.call("execute_tool", {
          name: "exec_command",
          params: { cmd: commandParts.join(" ") }
        });
      };

      const timeoutPromise = new Promise<{ error: string }>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Command timed out after ${timeoutMs}ms (wall-clock)`));
        }, timeoutMs);
      });

      const toolRes = await Promise.race([execPromise(), timeoutPromise]) as any;

      if (toolRes.error) {
        console.error("Execution error:", toolRes.error);
        process.exit(1);
      }

      const runRes = toolRes.result || {};
      if (runRes.stdout) console.log(runRes.stdout);
      if (runRes.stderr) console.error(runRes.stderr);
      process.exit(runRes.exit_code ?? runRes.exitCode ?? 0);
    } catch (e: any) {
      console.error(e.message);
      // 124 is the standard exit code for timeouts in CLI tools like 'timeout'
      const exitCode = e.message.includes("timed out") ? 124 : 1;
      process.exit(exitCode);
    } finally {
      bridge.stop();
    }
  });

program
  .command("search <query...>")
  .description("Search the web using AI-powered search")
  .option("-n, --max-results <n>", "Maximum results", "5")
  .action(async (queryParts: string[], opts) => {
    const bridge = new PythonBridge();
    const spinner = ora("Searching the web...").start();
    try {
      await bridge.start();
      const results = await bridge.call("search", {
        query: queryParts.join(" "),
        max_results: parseInt(opts.maxResults),
      });
      spinner.succeed("Search completed");
      console.log(JSON.stringify(results, null, 2));
    } catch (e: any) {
      spinner.fail(`Search failed: ${e.message}`);
      process.exit(1);
    } finally {
      bridge.stop();
    }
  });

program
  .command("edit <file>")
  .description("Edit a file with AI assistance securely via Python Bridge")
  .option("-i, --instruction <text>", "Edit instruction")
  .action(async (file: string, opts) => {
    const bridge = new PythonBridge();
    setupBridgeHandlers(bridge);

    let spinner = ora(`Starting edge router...`).start();
    try {
      await bridge.start();

      if (!opts.instruction) {
        spinner.fail("Please provide an instruction with -i flag");
        process.exit(1);
      }

      spinner.text = `Reading ${file}...`;
      const readResult = await bridge.call("execute_tool", {
        name: "read_file",
        params: { path: file }
      });

      if (readResult.error) {
        spinner.fail(`Read error: ${readResult.error}`);
        process.exit(1);
      }

      const content = readResult.result?.content || "";

      spinner.text = "LLM modifying file...";
      const result = await bridge.call("llm_chat", {
        messages: [
          {
            role: "system",
            content: "You are a code editor. Return ONLY the modified file content, no explanations.",
          },
          {
            role: "user",
            content: `File: ${file}\nInstruction: ${opts.instruction}\n\nCurrent content:\n${content}`,
          },
        ],
      });

      spinner.text = "Saving changes...";
      const writeResult = await bridge.call("execute_tool", {
        name: "write_file",
        params: { path: file, content: result.content }
      });

      if (writeResult.error) {
        spinner.fail("Write error: " + writeResult.error);
        process.exit(1);
      }

      spinner.succeed(`Successfully updated ${file}`);
    } catch (e: any) {
      spinner.fail(`Edit failed: ${e.message}`);
      process.exit(1);
    } finally {
      bridge.stop();
    }
  });

program
  .command("test")
  .description("Run verifier pipeline (tests, lint, typecheck)")
  .option("--skip-e2e", "Skip end-to-end tests")
  .action(async (opts) => {
    const verifier = createVerifier({ skipE2e: opts.skipE2e });
    const results = await verifier.runPipeline();
    for (const r of results) {
      const icon = r.passed ? "\u2713" : "\u2717";
      console.log(`${icon} ${r.stage}: ${r.passed ? "PASSED" : "FAILED"}`);
      if (!r.passed && r.errors.length > 0) {
        r.errors.forEach((e: string) => console.log(`  - ${e}`));
      }
    }
    const allPassed = results.every((r: { passed: boolean }) => r.passed);
    process.exit(allPassed ? 0 : 1);
  });

program
  .command("pr <action>")
  .description("PR management (create, review, list)")
  .option("-n, --number <n>", "PR number for review")
  .option("-b, --base <branch>", "Base branch", "main")
  .action(async (action: string, opts) => {
    const bridge = new PythonBridge();
    try {
      await bridge.start();
      const agent = createRepoAgent({ bridge });
      switch (action) {
        case "create":
          await agent.createPR({ base: opts.base });
          break;
        case "review":
          if (!opts.number) {
            console.error("PR number required: aurex pr review -n 42");
            process.exit(1);
          }
          await agent.reviewPR(parseInt(opts.number));
          break;
        case "list":
          await agent.listPRs();
          break;
        default:
          console.error(`Unknown action: ${action}`);
      }
    } finally {
      bridge.stop();
    }
  });

program
  .command("plan <task...>")
  .description("Generate an execution plan for a task")
  .action(async (taskParts: string[]) => {
    const bridge = new PythonBridge();
    const spinner = ora("Generating execution plan...").start();
    try {
      await bridge.start();
      const plan = await bridge.call("llm_plan", {
        task: taskParts.join(" "),
      });
      spinner.succeed("Plan generated");
      console.log(plan.plan);
    } catch (e: any) {
      spinner.fail(`Planning failed: ${e.message}`);
      process.exit(1);
    } finally {
      bridge.stop();
    }
  });

// Default: interactive mode
program.action(async () => {
  await startRepl();
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
