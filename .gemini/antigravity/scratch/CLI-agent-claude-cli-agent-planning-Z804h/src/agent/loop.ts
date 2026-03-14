import { PythonBridge } from "../bridge/python-bridge.js";
import { ModeManager, Mode } from "./modes.js";
import chalk from "chalk";
import ora from "ora";
import { z } from "zod";

const AgentResponseSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("tool_call"),
        id: z.string().optional(),
        tool: z.string(),
        args: z.record(z.unknown()),
    }),
    z.object({
        type: z.literal("final"),
        content: z.string(),
    }),
]);

export interface AgentContext {
    task: string;
    maxSteps: number;
    mode?: Mode;
}

export class AgentLoop {
    constructor(
        private bridge: PythonBridge,
        private modeManager?: ModeManager
    ) { }

    async run(context: AgentContext): Promise<void> {
        const currentMode = this.modeManager?.getMode() ?? Mode.ACT;

        // Mode gate: verify the current mode allows agent execution
        if (currentMode === Mode.CHAT) {
            console.log(chalk.yellow(
                "\n⚠ Modo CHAT não permite execução de ações. " +
                "Use /mode act ou /mode auto para executar."
            ));
            return;
        }

        if (currentMode === Mode.RESEARCH) {
            console.log(chalk.yellow(
                "\n⚠ Modo RESEARCH não permite execução de ações. " +
                "Use /mode act ou /mode auto para executar."
            ));
            return;
        }

        const spinner = ora("Delegating task to Python Agent Engine...").start();

        const pauseSpinner = () => { spinner.stop(); };
        const resumeSpinner = () => { spinner.start(); };

        this.bridge.on("pause_spinner", pauseSpinner);
        this.bridge.on("resume_spinner", resumeSpinner);

        try {
            const start = Date.now();

            // Pass mode context to the Python bridge
            const modeConfig = this.modeManager?.getConfig();
            const result = await this.bridge.call("agent_run", {
                user_input: context.task,
                max_steps: context.maxSteps,
                mode: currentMode,
                system_prompt_addition: modeConfig?.systemPromptAddition ?? '',
            }, 300000); // 5 min timeout for deep agent runs

            const elapsed = Date.now() - start;

            if (result.error) {
                spinner.fail(`Agent Engine failed: ${result.error}`);
                return;
            }

            const rounds = result.rounds || 0;
            const toolCalls = result.tool_calls || [];
            spinner.succeed(`Task complete [${rounds} round(s), ${toolCalls.length} tool call(s), ${elapsed}ms]`);

            if (result.status === "success") {
                if (toolCalls.length > 0) {
                    console.log(chalk.gray(`\n  Tools used: ${toolCalls.map((tc: any) => tc.name).join(", ")}`));
                }

                // Format if it's an object or string
                if (typeof result.output === 'object') {
                    console.log("\n" + chalk.green(JSON.stringify(result.output, null, 2)));
                } else {
                    console.log("\n" + chalk.green(result.output));
                }
            } else {
                console.log("\n" + chalk.yellow(JSON.stringify(result, null, 2)));
            }
        } catch (err: any) {
            spinner.fail(`Error communicating with Agent Engine: ${err.message}`);
            console.error(err);
        } finally {
            this.bridge.off("pause_spinner", pauseSpinner);
            this.bridge.off("resume_spinner", resumeSpinner);
        }
    }
}
