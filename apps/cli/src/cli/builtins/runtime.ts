// Runtime commands: open, status, trace, observability and sidecar start/stop.

import { tf, tr } from "../../i18n/translate.ts";
import {
	evalCommand,
	redteamCommand,
	withoutActionToken,
} from "../evalCommands.ts";
import { localize } from "../localizedText.ts";
import { type CliContext, type Command, UsageError } from "../types.ts";
import {
	type CommandJsonValue,
	callCore,
	commandJsonSchema,
	rawCommand,
	requireArg,
} from "./shared.ts";

export const openCommand = rawCommand(
	"open",
	"ryu-cli open <page>",
	"Open a Ryu deep-link target",
	"/api/deep-link",
	"POST",
	true
);
openCommand.aliases = ["link"];

export const statusCommand: Command = {
	name: "status",
	summary: "Show Core and sidecar status",
	usage: "ryu-cli status [--json]",
	run: async (ctx) => {
		const data = await ctx.api.call?.(ctx.target, "/api/system/status");
		if (data === undefined) {
			throw new Error("This command requires the live Core client.");
		}
		ctx.io.out(
			`${ctx.flags.json ? JSON.stringify(data, null, 2) : JSON.stringify(data)}\n`
		);
		return 0;
	},
};

function writeObservabilityResult(
	ctx: CliContext,
	result: Parameters<typeof JSON.stringify>[0]
): void {
	ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
}

/** `ryu trace <run-id>` — inspect the Core spans correlated to one run. */
export const traceCommand: Command = {
	aliases: ["traces"],
	name: "trace",
	summary: "Inspect the Core trace for a run",
	usage: "ryu-cli trace <run-id> [--json]",
	run: async (ctx) => {
		const runId = requireArg(ctx, "run id", "ryu-cli trace <run-id>");
		const result = await callCore(
			ctx,
			`/api/runs/${encodeURIComponent(runId)}/trace`,
			{ method: "GET" }
		);
		writeObservabilityResult(ctx, result);
		return 0;
	},
};

/**
 * `ryu observability <audit|trace|eval|redteam|score>` is the scriptable umbrella
 * for the same observe → inspect → evaluate → secure workflow shown in Desktop.
 * The focused top-level aliases remain available for CI and shell scripts.
 */
export const observabilityCommand: Command = {
	aliases: ["obs"],
	name: "observability",
	summary: "Inspect traces, audits, evals, and security probes",
	usage: "ryu-cli observability <audit|trace|eval|redteam|score|audit-prune> …",
	run: async (ctx) => {
		const action = ctx.args[0] ?? "audit";
		if (action === "audit") {
			const agentId = ctx.args[1] ?? ctx.flags.agent;
			const query = new URLSearchParams({ limit: "100" });
			if (agentId) {
				query.set("agent_id", agentId);
			}
			const result = await callCore(ctx, `/api/gateway/audit?${query}`, {
				method: "GET",
			});
			writeObservabilityResult(ctx, result);
			return 0;
		}
		if (action === "audit-prune") {
			const result = await callCore(ctx, "/api/gateway/audit/prune", {
				method: "POST",
			});
			writeObservabilityResult(ctx, result);
			return 0;
		}
		if (action === "score") {
			const agentId = ctx.args[1] ?? ctx.flags.agent;
			const responseText = ctx.args[2] ?? process.env.RYU_EVAL_RESPONSE;
			if (!(agentId && responseText)) {
				throw new UsageError(
					"Usage: ryu-cli observability score <agent-id> <response> [model] [--json]"
				);
			}
			let response: CommandJsonValue = responseText;
			try {
				response = commandJsonSchema.parse(JSON.parse(responseText));
			} catch {
				// Plain text is the normal CLI form; JSON remains available for
				// already-shaped provider output.
			}
			const result = await callCore(ctx, "/api/gateway/evals/score", {
				body: {
					agent_id: agentId,
					model: ctx.args[3],
					prompt: "ryu observability score",
					response,
				},
			});
			writeObservabilityResult(ctx, result);
			return 0;
		}
		const command =
			action === "trace"
				? traceCommand
				: action === "eval"
					? evalCommand
					: action === "redteam"
						? redteamCommand
						: null;
		if (!command) {
			throw new UsageError(
				"Usage: ryu-cli observability <audit|trace|eval|redteam|score|audit-prune> …"
			);
		}
		// Drop the action token so the delegated command parses its own flags
		// from the same tokens a top-level `ryu eval …` would see.
		return command.run({
			...ctx,
			args: ctx.args.slice(1),
			rawArgs: withoutActionToken(ctx.rawArgs, action),
		});
	},
};

/** Whole sentences per verb so translations never assemble "<Verb>d <target>". */
const SIDECAR_SUMMARIES = {
	restart: tr("Restart a sidecar"),
	start: tr("Start a sidecar"),
	stop: tr("Stop a sidecar"),
} as const;

const SIDECAR_DONE = {
	restart: (target: string) => tf("Restarted {target}.", { target }),
	start: (target: string) => tf("Started {target}.", { target }),
	stop: (target: string) => tf("Stopped {target}.", { target }),
} as const;

export function sidecarCommand(name: "start" | "stop" | "restart"): Command {
	return {
		name,
		summary: SIDECAR_SUMMARIES[name],
		usage: `ryu-cli ${name} <name|all>`,
		run: async (ctx) => {
			const target = ctx.args[0] ?? (name === "restart" ? null : "all");
			if (!target) {
				throw new UsageError(
					localize("Usage: {usage}", { usage: `ryu-cli ${name} <name>` })
				);
			}
			const path =
				target === "all"
					? `/api/sidecar/${name}-all`
					: `/api/sidecar/${encodeURIComponent(target)}/${name}`;
			await callCore(ctx, path);
			ctx.io.out(`${SIDECAR_DONE[name](target)}\n`);
			return 0;
		},
	};
}
