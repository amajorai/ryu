// `ryu secrets agent --config FILE [--once]`: a long-running client agent, the
// equivalent of the Vault, OpenBao and Infisical agents. It logs in with a
// machine identity and keeps the token renewed (auto-auth), writes the token
// to sink files, renders templates with vault values and dynamic credentials,
// renders them again when a value changes or a lease is replaced, and runs a
// command after each render that changed a file.
//
// Config format: `secrets-agentd-config.ts`. Template grammar:
// `secrets-agentd-template.ts`. Loop and renewal: `secrets-agentd-daemon.ts`.
// The agent writes secret values to disk, so an AI agent session is refused
// unless a person confirms `--human` (checked in `secrets.ts`).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tf } from "../i18n/translate.ts";
import { parseAgentConfig } from "./secrets-agentd-config.ts";
import { runAgentDaemon } from "./secrets-agentd-daemon.ts";
import { systemClock } from "./secrets-agentd-schedule.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { type CliContext, UsageError } from "./types.ts";
import { defaultContainerHost } from "./vaultIsolation.ts";

const AGENT_USAGE = "Usage: ryu-cli secrets agent --config FILE [--once]";

export async function agentCommand(
	ctx: CliContext,
	args: SecretsArgs
): Promise<number> {
	const file = flag(args, "--config");
	if (!file || args.positional.length > 1) {
		throw new UsageError(AGENT_USAGE);
	}
	const path = resolve(ctx.cwd ?? process.cwd(), file);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new UsageError(tf("Cannot read {file}.", { file: path }));
	}
	const config = parseAgentConfig(text, path);
	if (config.templates.length === 0 && config.sinks.length === 0) {
		throw new UsageError(
			tf(
				"{file} has no templates and no sinks, so the agent has nothing to do.",
				{
					file: path,
				}
			)
		);
	}
	const host = ctx.containerHost ?? defaultContainerHost();
	return await runAgentDaemon(ctx, config, {
		clock: systemClock,
		once: args.booleans.has("--once"),
		onSignal: host.onSignal,
	});
}
