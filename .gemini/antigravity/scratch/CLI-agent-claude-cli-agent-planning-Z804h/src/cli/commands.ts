import chalk from "chalk";

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
}

export const COMMANDS: CommandDef[] = [
  { name: "help", aliases: ["h"], description: "Show this help message", usage: "/help" },
  { name: "mode", aliases: ["m"], description: "Switch or show operational mode", usage: "/mode <CHAT|PLAN|ACT|AUTO|RESEARCH>" },
  { name: "approve", aliases: [], description: "Approve current plan (PLAN mode only)", usage: "/approve" },
  { name: "search", aliases: ["s"], description: "Search the web", usage: "/search <query>" },
  { name: "exec", aliases: ["x"], description: "Execute command (ACT/AUTO only)", usage: "/exec <command>" },
  { name: "test", aliases: ["t"], description: "Run verifier pipeline", usage: "/test" },
  { name: "plan", aliases: ["p"], description: "Switch to PLAN mode / generate plan", usage: "/plan [task]" },
  { name: "act", aliases: [], description: "Switch to ACT mode / run task", usage: "/act [task]" },
  { name: "auto", aliases: [], description: "Switch to AUTO mode / run autonomously", usage: "/auto [task]" },
  { name: "chat", aliases: [], description: "Switch to CHAT mode", usage: "/chat [message]" },
  { name: "research", aliases: [], description: "Switch to RESEARCH mode / research topic", usage: "/research [topic]" },
  { name: "read", aliases: ["r"], description: "Read a file", usage: "/read <file>" },
  { name: "fetch", aliases: ["f"], description: "Fetch and extract URL content", usage: "/fetch <url>" },
  { name: "resume", aliases: [], description: "Resume previous session history", usage: "/resume" },
  { name: "history", aliases: [], description: "Check session context size", usage: "/history" },
  { name: "clear", aliases: ["c"], description: "Clear current session context", usage: "/clear" },
  { name: "code", aliases: [], description: "Focus prompt on writing code", usage: "/code <request>" },
  { name: "fix", aliases: [], description: "Focus prompt on debugging", usage: "/fix <error>" },
  { name: "explain", aliases: [], description: "Explain technical concepts", usage: "/explain <concept>" },
  { name: "copy", aliases: [], description: "Copy last response (/copy code for snippets)", usage: "/copy [code|last]" },
];

export function getHelp(): string {
  const lines = [
    chalk.bold.cyan("\nAurexAI Commands\n"),
    chalk.gray("  Modes:"),
    ...COMMANDS.filter(c => ["mode", "approve", "plan", "act", "auto", "chat", "research"].includes(c.name)).map(
      (c) =>
        `    ${chalk.green(c.usage.padEnd(42))} ${c.description}` +
        (c.aliases.length ? chalk.gray(` (/${c.aliases.join(", /")})`) : "")
    ),
    "",
    chalk.gray("  Tools:"),
    ...COMMANDS.filter(c => ["search", "exec", "test", "read", "fetch"].includes(c.name)).map(
      (c) =>
        `    ${chalk.green(c.usage.padEnd(42))} ${c.description}` +
        (c.aliases.length ? chalk.gray(` (/${c.aliases.join(", /")})`) : "")
    ),
    "",
    chalk.gray("  Session:"),
    ...COMMANDS.filter(c => ["resume", "history", "clear", "copy"].includes(c.name)).map(
      (c) =>
        `    ${chalk.green(c.usage.padEnd(42))} ${c.description}` +
        (c.aliases.length ? chalk.gray(` (/${c.aliases.join(", /")})`) : "")
    ),
    "",
    chalk.gray("  Prompts:"),
    ...COMMANDS.filter(c => ["code", "fix", "explain"].includes(c.name)).map(
      (c) =>
        `    ${chalk.green(c.usage.padEnd(42))} ${c.description}` +
        (c.aliases.length ? chalk.gray(` (/${c.aliases.join(", /")})`) : "")
    ),
    "",
    chalk.gray("  Other:"),
    ...COMMANDS.filter(c => ["help"].includes(c.name)).map(
      (c) =>
        `    ${chalk.green(c.usage.padEnd(42))} ${c.description}` +
        (c.aliases.length ? chalk.gray(` (/${c.aliases.join(", /")})`) : "")
    ),
    "",
    chalk.gray("  Or just type naturally to chat with the AI.\n"),
  ];
  return lines.join("\n");
}
