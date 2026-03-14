import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { PythonBridge } from "../bridge/python-bridge.js";
import { createExecutor } from "../executor/runner.js";
import { createVerifier } from "../verifier/test-runner.js";
import { readFile, writeFile } from "../editor/file-ops.js";
import { renderMarkdown, renderCitations } from "./renderer.js";
import { COMMANDS, getHelp } from "./commands.js";
import { setupBridgeHandlers } from "./setup-bridge.js";
import { ModeManager, Mode, MODE_EMOJI } from "../agent/modes.js";

const HISTORY_FILE = path.join(os.homedir(), ".aurex_history");
let lastServerResponse = "";

// ─── Mode Manager (shared instance) ─────────────────────

const modeManager = new ModeManager();

let sandboxState = process.env.AUREX_NO_SANDBOX ? "OFF" : "ON";
let approvalState = "ASK";
let projectName = path.basename(process.cwd());

const AUREX_PURPLE = "#5e2fb5";
const AUREX_GOLD = "#ffb800";

function printBadge() {
  const mode = modeManager.getMode();
  const emoji = modeManager.getEmoji();
  console.log(`\n${chalk.bgHex(AUREX_PURPLE).white.bold(" AUREX ")} ${chalk.gray("project:")} ${chalk.cyan(projectName)}  ${chalk.gray("mode:")} ${chalk.cyan(`${emoji} ${mode}`)}  ${chalk.gray("sandbox:")} ${chalk.cyan(sandboxState)}  ${chalk.gray("approvals:")} ${chalk.cyan(approvalState)}\n`);
}

function updatePrompt(rl: readline.Interface) {
  const mode = modeManager.getMode();
  const emoji = modeManager.getEmoji();
  rl.setPrompt(chalk.hex(AUREX_PURPLE).bold("aurex ") + chalk.gray(`[${emoji} ${mode}] `) + chalk.green("❯ "));
}

function parseCommandArgs(input: string): string[] {
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(input)) !== null) {
    matches.push(match[1] || match[2] || match[3]);
  }
  return matches;
}

export async function startRepl(): Promise<void> {
  const bridge = new PythonBridge();
  const executor = createExecutor({});

  // Configure ModeManager confirmation function for AUTO mode
  modeManager.setConfirmFunction(async (message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      console.log(chalk.yellow(`\n${message}`));
      const confirmRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      confirmRl.question(chalk.cyan("  (s/N): "), (answer) => {
        confirmRl.close();
        resolve(answer.toLowerCase() === 's' || answer.toLowerCase() === 'sim' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  });

  printBadge();
  console.log(chalk.gray("Type /help for commands, Ctrl+C to exit\n"));

  try {
    await bridge.start();
  } catch (err) {
    console.log(chalk.yellow("  Python bridge not available. LLM/search features disabled."));
    console.log(chalk.gray("  Run: cd python && pip install -e .\n"));
  }

  const completer = (line: string) => {
    const completions = ["/help", "/search", "/exec", "/edit", "/test", "/plan", "/agent", "/read", "/fetch", "/exit", "/resume", "/history", "/clear", "/code", "/fix", "/explain", "/copy", "/mode", "/research", "/approve"];
    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  updatePrompt(rl);

  // monkey patch completer to avoid readline prompt recreation issues if needed
  (rl as any).completer = completer;

  // Load history
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const history = fs.readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
      (rl as any).history = history.reverse(); // readline requires reversed array
    } catch {
      // Ignore history read errors
    }
  }

  setupBridgeHandlers(bridge, rl);

  // Listen for mode changes to update prompt
  modeManager.on('modeChange', () => {
    updatePrompt(rl);
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    rl.pause(); // Explicitly pause input processing to prevent terminal corruption

    const input = line.trim();
    if (!input) {
      rl.resume();
      rl.prompt();
      return;
    }

    try {
      if (input.startsWith("/")) {
        fs.appendFileSync(HISTORY_FILE, input + "\n");
        await handleCommand(input, bridge, executor, rl);
      } else {
        fs.appendFileSync(HISTORY_FILE, input + "\n");
        const currentMode = modeManager.getMode();

        if (currentMode === Mode.PLAN) {
          console.log(chalk.cyan(`\n📋 Planning task...\n`));
          const planSpinner = ora("Generating execution plan...").start();
          try {
            const plan = await bridge.call("llm_plan", { task: input });
            planSpinner.succeed("Plan generated");
            renderMarkdown(plan.plan);
          } catch (e: any) {
            planSpinner.fail(`Planning failed: ${e.message}`);
          }
        } else if (currentMode === Mode.ACT || currentMode === Mode.AUTO) {
          const emoji = modeManager.getEmoji();
          console.log(chalk.cyan(`\n${emoji} ${currentMode === Mode.AUTO ? 'Running autonomously' : 'Acting on task'}...\n`));
          try {
            const { AgentLoop } = await import("../agent/loop.js");
            const loop = new AgentLoop(bridge, modeManager);
            await loop.run({
              task: input,
              maxSteps: currentMode === Mode.AUTO ? 30 : 15,
              mode: currentMode,
            });
          } catch (e: any) {
            console.log(chalk.red(`Agent run failed: ${e.message}`));
          }
        } else if (currentMode === Mode.RESEARCH) {
          console.log(chalk.cyan(`\n🔍 Researching...\n`));
          const researchPrompt = modeManager.getConfig().systemPromptAddition;
          await handleChat(input, bridge, researchPrompt);
        } else {
          // CHAT mode
          const chatPrompt = modeManager.getConfig().systemPromptAddition;
          await handleChat(input, bridge, chatPrompt);
        }
      }
    } catch (err: any) {
      console.log(chalk.red(`Error: ${err.message}`));
    }

    rl.resume(); // Restore input processing
    rl.prompt();
  });

  rl.on("close", () => {
    bridge.stop();
    console.log(chalk.gray("\nGoodbye!"));
    process.exit(0);
  });
}

async function handleCommand(
  input: string,
  bridge: PythonBridge,
  executor: ReturnType<typeof createExecutor>,
  rl: readline.Interface
): Promise<void> {
  const parts = parseCommandArgs(input.slice(1));
  const cmd = parts[0];
  const args = parts.slice(1).join(" "); // Re-join for backward compatibility with some commands, or they can use parts
  const parsedArgs = parts.slice(1);

  switch (cmd) {
    case "help":
      console.log(getHelp());
      break;

    case "mode":
    case "m": {
      if (!args) {
        const mode = modeManager.getMode();
        const emoji = modeManager.getEmoji();
        console.log(chalk.cyan(`\n  Current mode: ${emoji} ${mode}`));
        console.log(chalk.gray(`  Available modes: ${Object.values(Mode).join(', ')}`));
        console.log(chalk.gray(`  Usage: /mode <CHAT|PLAN|ACT|AUTO|RESEARCH>\n`));
        break;
      }
      const targetMode = args.toUpperCase() as Mode;
      if (!Object.values(Mode).includes(targetMode)) {
        console.log(chalk.yellow(`Unknown mode: ${args}. Available: ${Object.values(Mode).join(', ')}`));
        break;
      }
      try {
        await modeManager.switch(targetMode);
        printBadge();
        const modeDescriptions: Record<Mode, string> = {
          [Mode.CHAT]: "Safe, read-only interactions. No file edits or command execution.",
          [Mode.PLAN]: "Read, analyze, and propose changes. No execution.",
          [Mode.ACT]: "Execute actions with approval for each modification.",
          [Mode.AUTO]: "Autonomous execution with fewer approvals.",
          [Mode.RESEARCH]: "Web research and information gathering only.",
        };
        console.log(chalk.gray(`  ${modeDescriptions[targetMode]}\n`));
      } catch (e: any) {
        console.log(chalk.red(`  ${e.message}\n`));
      }
      break;
    }

    case "approve": {
      if (modeManager.getMode() !== Mode.PLAN) {
        console.log(chalk.yellow("  /approve only works in PLAN mode.\n"));
        break;
      }
      modeManager.setApprovedPlan(true);
      console.log(chalk.green("  ✓ Plan approved. You can now switch to ACT mode with /mode act.\n"));
      break;
    }

    case "search":
    case "s":
      if (!args) {
        console.log(chalk.yellow("Usage: /search <query>"));
        break;
      }
      const searchSpinner = ora("Searching the web...").start();
      try {
        const searchResults = await bridge.call("search", { query: args });
        searchSpinner.succeed("Search completed");
        renderCitations(searchResults.citations || []);
      } catch (e: any) {
        searchSpinner.fail(`Search failed: ${e.message}`);
      }
      break;

    case "exec":
    case "x":
      if (!args) {
        console.log(chalk.yellow("Usage: /exec <command>"));
        break;
      }
      // Mode gate for exec
      if (modeManager.getMode() === Mode.CHAT || modeManager.getMode() === Mode.RESEARCH) {
        console.log(chalk.yellow(`  ⚠ Command execution not available in ${modeManager.getMode()} mode. Use /mode act.\n`));
        break;
      }
      console.log(chalk.cyan(`\n⚡ Running: ${args}\n`));
      try {
        const result = await bridge.call("execute_tool", { name: "exec_command", params: { cmd: args } });
        if (result.error) {
          console.log(chalk.red(`\nError: ${result.error}`));
        } else {
          const runRes = result.result;
          console.log(chalk.gray(`\nExit code: ${runRes.exit_code}`));
        }
      } catch (e: any) {
        console.log(chalk.red(`\nExecution failed: ${e.message}`));
      }
      break;

    case "edit":
    case "e":
      // Mode gate for edit
      if (modeManager.getMode() === Mode.CHAT || modeManager.getMode() === Mode.PLAN || modeManager.getMode() === Mode.RESEARCH) {
        console.log(chalk.yellow(`  ⚠ File editing not available in ${modeManager.getMode()} mode. Use /mode act.\n`));
        break;
      }
      console.log(chalk.yellow("The /edit command has been deprecated locally. Please use /act to edit files."));
      break;

    case "test":
    case "t":
      const testSpinner = ora("Running verification pipeline...").start();
      try {
        const verifier = createVerifier({});
        const testResults = await verifier.runPipeline();
        testSpinner.stop();
        for (const r of testResults) {
          const icon = r.passed ? chalk.green("\u2713") : chalk.red("\u2717");
          console.log(`${icon} ${r.stage}: ${r.passed ? chalk.green("PASSED") : chalk.red("FAILED")}`);
        }
      } catch (e: any) {
        testSpinner.fail(`Verification pipeline failed: ${e.message}`);
      }
      break;

    case "plan":
    case "p":
      if (modeManager.getMode() !== Mode.PLAN) {
        try {
          await modeManager.switch(Mode.PLAN);
          printBadge();
        } catch (e: any) {
          console.log(chalk.red(`  ${e.message}`));
          break;
        }
      }
      if (!args) {
        console.log(chalk.gray("Switched to PLAN mode. Type your task to generate a plan.\n"));
        break;
      }
      const planSpinner = ora("Generating execution plan...").start();
      try {
        const plan = await bridge.call("llm_plan", { task: args });
        planSpinner.succeed("Plan generated");
        renderMarkdown(plan.plan);
      } catch (e: any) {
        planSpinner.fail(`Planning failed: ${e.message}`);
      }
      break;

    case "act":
      if (modeManager.getMode() !== Mode.ACT) {
        try {
          await modeManager.switch(Mode.ACT);
          printBadge();
        } catch (e: any) {
          console.log(chalk.red(`  ${e.message}`));
          break;
        }
      }
      if (!args) {
        console.log(chalk.gray("Switched to ACT mode. Edit actions require approval.\n"));
        break;
      }
      console.log(chalk.cyan("\n⚡ Acting on task...\n"));
      try {
        const { AgentLoop } = await import("../agent/loop.js");
        const loop = new AgentLoop(bridge, modeManager);
        await loop.run({ task: args, maxSteps: 15, mode: Mode.ACT });
      } catch (e: any) {
        console.log(chalk.red(`Agent run failed: ${e.message}`));
      }
      break;

    case "auto":
      if (modeManager.getMode() !== Mode.AUTO) {
        try {
          await modeManager.switch(Mode.AUTO);
          printBadge();
        } catch (e: any) {
          console.log(chalk.red(`  ${e.message}`));
          break;
        }
      }
      if (!args) {
        console.log(chalk.gray("Switched to AUTO mode. Autonomous execution with fewer approvals.\n"));
        break;
      }
      console.log(chalk.cyan("\n🔄 Running autonomously...\n"));
      try {
        const { AgentLoop } = await import("../agent/loop.js");
        const loop = new AgentLoop(bridge, modeManager);
        await loop.run({ task: args, maxSteps: 30, mode: Mode.AUTO });
      } catch (e: any) {
        console.log(chalk.red(`Agent run failed: ${e.message}`));
      }
      break;

    case "chat":
      if (modeManager.getMode() !== Mode.CHAT) {
        try {
          await modeManager.switch(Mode.CHAT);
          printBadge();
        } catch (e: any) {
          console.log(chalk.red(`  ${e.message}`));
          break;
        }
      }
      if (!args) {
        console.log(chalk.gray("Switched to CHAT mode. Safe, read-only interactions.\n"));
        break;
      }
      await handleChat(args, bridge);
      break;

    case "research":
      if (modeManager.getMode() !== Mode.RESEARCH) {
        try {
          await modeManager.switch(Mode.RESEARCH);
          printBadge();
        } catch (e: any) {
          console.log(chalk.red(`  ${e.message}`));
          break;
        }
      }
      if (!args) {
        console.log(chalk.gray("Switched to RESEARCH mode. Web research and information gathering.\n"));
        break;
      }
      const researchPrompt = modeManager.getConfig().systemPromptAddition;
      await handleChat(args, bridge, researchPrompt);
      break;

    case "agent":
    case "a":
      console.log(chalk.yellow("The /agent command is deprecated. Use /act or /auto instead."));
      break;

    case "read":
    case "r":
      if (!args) {
        console.log(chalk.yellow("Usage: /read <file>"));
        break;
      }
      const readSpinner = ora(`Reading ${args}...`).start();
      try {
        const readRes = await bridge.call("execute_tool", { name: "read_file", params: { path: args } });
        if (readRes.error) {
          readSpinner.fail(`Read error: ${readRes.error}`);
        } else {
          readSpinner.stop();
          console.log(chalk.bold.blue(`\n--- ${args} ---`));
          console.log(readRes.result.content);
        }
      } catch (e: any) {
        readSpinner.fail(`Read failed: ${e.message}`);
      }
      break;

    case "fetch":
    case "f":
      if (!args) {
        console.log(chalk.yellow("Usage: /fetch <url>"));
        break;
      }
      const fetchSpinner = ora(`Fetching ${args}...`).start();
      try {
        const fetched = await bridge.call("fetch_url", { url: args });
        fetchSpinner.succeed(`Fetched ${args}`);
        console.log(fetched.content);
      } catch (e: any) {
        fetchSpinner.fail(`Fetch failed: ${e.message}`);
      }
      break;

    case "resume":
      const resumeSpinner = ora("Resuming session...").start();
      try {
        const res = await bridge.call("manage_history", { action: "load" });
        if (res.success) {
          resumeSpinner.succeed(`Session resumed. Loaded ${res.length} context items.`);
        } else {
          resumeSpinner.fail("No previous session found.");
        }
      } catch (e: any) {
        resumeSpinner.fail(`Failed to resume: ${e.message}`);
      }
      break;

    case "history":
      const histSpinner = ora("Checking history...").start();
      try {
        const res = await bridge.call("manage_history", { action: "status" });
        histSpinner.succeed(`Current session has ${res.length} context items.`);
      } catch (e: any) {
        histSpinner.fail(`Failed to check history: ${e.message}`);
      }
      break;

    case "clear":
    case "c":
      const clearSpinner = ora("Clearing history...").start();
      try {
        const res = await bridge.call("manage_history", { action: "clear" });
        clearSpinner.succeed("Session history cleared.");
      } catch (e: any) {
        clearSpinner.fail(`Failed to clear: ${e.message}`);
      }
      break;

    case "undo":
    case "u":
      const undoSpinner = ora("Undoing last interaction...").start();
      try {
        const res = await bridge.call("manage_history", { action: "undo" });
        if (res.success) {
          undoSpinner.succeed(`History rewound. Current session has ${res.length} context items.`);
        } else {
          undoSpinner.fail(`Failed to undo: ${res.message}`);
        }
      } catch (e: any) {
        undoSpinner.fail(`Failed to undo: ${e.message}`);
      }
      break;

    case "code":
      if (!args) { console.log(chalk.yellow("Usage: /code <request>")); break; }
      const codePrompt = "You are an expert software engineer. Meticulously plan and emit production-ready code. Use best practices and clear architecture.";
      await handleChat(args, bridge, codePrompt);
      break;

    case "fix":
      if (!args) { console.log(chalk.yellow("Usage: /fix <error or description>")); break; }
      const fixPrompt = "You are a debugging expert. Analyze the error carefully, explain the root cause, and provide a fix.";
      await handleChat(args, bridge, fixPrompt);
      break;

    case "explain":
      if (!args) { console.log(chalk.yellow("Usage: /explain <concept or code>")); break; }
      const explainPrompt = "You are a technical teacher. Explain the following concept or code snippet clearly, concisely, and with examples.";
      await handleChat(args, bridge, explainPrompt);
      break;

    case "copy":
      try {
        const { default: clipboardy } = await import("clipboardy");
        if (!lastServerResponse) {
          console.log(chalk.yellow("Nothing to copy yet."));
          break;
        }
        if (args === "code") {
          const regex = /```\w*\n([\s\S]*?)```/g;
          let codeBlocks = "";
          let match;
          while ((match = regex.exec(lastServerResponse)) !== null) {
            codeBlocks += match[1] + "\n\n";
          }
          if (codeBlocks) {
            await clipboardy.write(codeBlocks.trim());
            console.log(chalk.green("Copied code blocks to clipboard!"));
          } else {
            console.log(chalk.yellow("No code blocks found in last response."));
          }
        } else {
          await clipboardy.write(lastServerResponse);
          console.log(chalk.green("Copied last response to clipboard!"));
        }
      } catch (e: any) {
        console.log(chalk.red(`Failed to copy: ${e.message}`));
      }
      break;

    case "exit":
    case "q":
      console.log(chalk.gray("\nGoodbye!"));
      process.exit(0);
      break;

    default:
      console.log(chalk.yellow(`Unknown command: /${cmd}. Type /help for available commands.`));
  }
}

async function handleChat(input: string, bridge: PythonBridge, systemPrompt?: string): Promise<void> {
  console.log(); // visual spacing

  const spinner = ora("Thinking...").start();
  let firstTokenReceived = false;
  let currentResponse = "";

  const onToken = (chunk: any) => {
    if (!firstTokenReceived) {
      spinner.stop();
      firstTokenReceived = true;
    }
    if (chunk.type === "token" && chunk.content) {
      currentResponse += chunk.content;
      process.stdout.write(chalk.cyan(chunk.content));
    }
  };

  bridge.on("stream_token", onToken);

  try {
    const params: any = { prompt: input };
    if (systemPrompt) params.system_prompt = systemPrompt;

    await bridge.call("llm_stream", params, 300000);
    if (!firstTokenReceived) spinner.stop();
    console.log("\n"); // Double newline after finishing stream
    lastServerResponse = currentResponse;
  } catch (e: any) {
    if (!firstTokenReceived) spinner.stop();
    console.log(chalk.red(`\nStreaming Error: ${e.message}`));
  } finally {
    bridge.off("stream_token", onToken);
  }
}
