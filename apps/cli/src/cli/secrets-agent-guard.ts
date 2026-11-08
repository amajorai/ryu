// AI coding-agent safety for `ryu secrets …`.
//
// Coding agents (Claude Code, Cursor, Codex, and tools that set `AGENT`) run
// the CLI on a person's behalf and read everything it prints. When one is
// detected, redaction follows the value type (`secrets-agent-redaction.ts`):
// `get` and `export` show `config` values only, and the other value-printing
// subcommands refuse before any request reaches the node. `run` defaults to
// the credential broker when the node has services for the environment (the
// command then also gets the `config` values), and `run` refuses commands
// whose purpose is to print the child's environment. A person at a real terminal can pass `--human` and
// answer a prompt to lift the guard for one invocation; an agent without a
// terminal gets no prompt and stays guarded.

import {
	listVaultBrokerServices,
	vaultAgentBrokerDiscover,
} from "@ryuhq/core-client/vault";
import { z } from "zod";
import { tf } from "../i18n/translate.ts";
import { flag, type SecretsArgs } from "./secrets-args.ts";
import { dumpsEnvironment, readsScriptFromStdin } from "./secrets-env-dump.ts";
import { agentTarget } from "./secrets-output.ts";
import type { CliContext } from "./types.ts";

export const HUMAN_OVERRIDE_FLAG = "--human";

/** Runs an agent session sends through the broker (set by `prepareAgentRun`). */
const agentBrokerRuns = new WeakSet<SecretsArgs>();

/** Whether this `run` is an agent session's broker run, which gets the
 *  `config` values in its environment. */
export function isAgentBrokerRun(args: SecretsArgs): boolean {
	return agentBrokerRuns.has(args);
}
const HUMAN_CONFIRMATION = "human";

/** Variables coding agents set in the shells they drive. */
const AGENT_MARKERS = ["CLAUDECODE", "CURSOR_AGENT", "AGENT"];
/** `CODEX_HOME` is a configuration path people export in their own shell. */
const CODEX_PREFIX = "CODEX_";
const CODEX_NON_MARKERS = new Set(["CODEX_HOME"]);

function isSet(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase() ?? "";
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** The variable that marks this process as driven by a coding agent, or null. */
export function detectAgentSession(
	env: Record<string, string | undefined>
): string | null {
	for (const name of AGENT_MARKERS) {
		if (isSet(env[name])) {
			return name;
		}
	}
	for (const [name, value] of Object.entries(env)) {
		if (
			name.startsWith(CODEX_PREFIX) &&
			!CODEX_NON_MARKERS.has(name) &&
			isSet(value)
		) {
			return name;
		}
	}
	return null;
}

/** Subcommands that print a secret value (or a wrapped one) to stdout. */
export function printsSecretValues(args: SecretsArgs): boolean {
	const [command, action] = args.positional;
	switch (command) {
		case "get":
		case "export":
		case "unwrap":
			return true;
		case "snapshot":
			return true;
		case "dynamic":
			return action === "issue";
		case "items":
			return action === "reveal";
		case "pm":
			return action === "read";
		default:
			return false;
	}
}

// ── Guard ────────────────────────────────────────────────────────────────────

/**
 * The detected agent marker when the guard applies, or null when no agent is
 * detected or a person confirmed `--human` at a terminal. `--human` without
 * a terminal to answer on keeps the guard on.
 */
export async function guardedAgentSession(
	ctx: CliContext,
	args: SecretsArgs
): Promise<string | null> {
	const marker = detectAgentSession(ctx.env);
	if (!(marker && args.booleans.has(HUMAN_OVERRIDE_FLAG))) {
		return marker;
	}
	const answer = await ctx.promptLine(
		tf(
			"An AI agent session was detected ({marker}). Type {word} to confirm a person is running this command: ",
			{ marker, word: HUMAN_CONFIRMATION }
		)
	);
	if (answer?.trim().toLowerCase() === HUMAN_CONFIRMATION) {
		return null;
	}
	ctx.io.err(
		"--human needs a person to confirm at an interactive terminal; the agent guard stays on.\n"
	);
	return marker;
}

export function refuseValueOutput(ctx: CliContext, marker: string): number {
	ctx.io.err(
		`${tf("Refusing to print secret values in an AI agent session ({marker} is set). List names with 'ryu-cli secrets list', or let the command use them with 'ryu-cli secrets run --broker SERVICE -- CMD'. A person at a terminal can add --human.", { marker })}\n`
	);
	return 1;
}

export function refuseEnvironmentDump(ctx: CliContext, marker: string): number {
	ctx.io.err(
		`${tf("Refusing to run a command that prints its environment in an AI agent session ({marker} is set); it would expose the injected values. A person at a terminal can add --human.", { marker })}\n`
	);
	return 1;
}

const namedService = z.object({ name: z.string().min(1) });

/** The broker services listing for the run's environment. A failed listing
 *  is not an empty one: it says nothing about whether services exist. */
export type BrokerServiceListing =
	| { ok: true; services: string[] }
	| { ok: false };

/** The enabled broker services this caller may use in the run's environment. */
export async function availableBrokerServices(
	ctx: CliContext,
	args: SecretsArgs
): Promise<BrokerServiceListing> {
	const environment = flag(args, "--env");
	try {
		const agent = agentTarget(ctx);
		if (agent) {
			const discovery = await vaultAgentBrokerDiscover(agent, { environment });
			return {
				ok: true,
				services: discovery.services.flatMap((service) => {
					const parsed = namedService.safeParse(service);
					return parsed.success ? [parsed.data.name] : [];
				}),
			};
		}
		const { services } = await listVaultBrokerServices(ctx.target, {
			environment,
		});
		return {
			ok: true,
			services: services
				.filter((service) => service.enabled)
				.map((service) => service.name),
		};
	} catch {
		return { ok: false };
	}
}

function refuseUnknownBroker(ctx: CliContext, marker: string): number {
	ctx.io.err(
		`${tf("Refusing to run in an AI agent session ({marker} is set): the broker services could not be listed, so values would go into the command's environment. Pass --broker SERVICE, or a person at a terminal can add --human.", { marker })}\n`
	);
	return 1;
}

function refuseStdinShell(ctx: CliContext, marker: string): number {
	ctx.io.err(
		`${tf("Refusing to start a shell that reads its script from stdin in an AI agent session ({marker} is set); it could print the injected values. Pass the script with -c, use --broker SERVICE, or a person at a terminal can add --human.", { marker })}\n`
	);
	return 1;
}

/**
 * `run` in an AI agent session: refuse a command that prints its environment,
 * then default to `--broker` with every service the caller may use, so the
 * child never holds a value. When the services cannot be listed, or values
 * would reach a shell reading its script from stdin, the run is refused.
 * Returns an exit code when the run is refused.
 */
export async function prepareAgentRun(
	ctx: CliContext,
	args: SecretsArgs,
	marker: string
): Promise<number | null> {
	const command = args.passthrough ?? [];
	if (command.length > 0 && dumpsEnvironment(command)) {
		return refuseEnvironmentDump(ctx, marker);
	}
	if (command.length === 0) {
		return null;
	}
	if (args.values.has("--broker")) {
		agentBrokerRuns.add(args);
		return null;
	}
	const listing = await availableBrokerServices(ctx, args);
	if (!listing.ok) {
		return refuseUnknownBroker(ctx, marker);
	}
	const { services } = listing;
	if (services.length === 0) {
		if (readsScriptFromStdin(command)) {
			return refuseStdinShell(ctx, marker);
		}
		ctx.io.err(
			`${tf("AI agent session detected ({marker}); no broker services are available, so values go into the command's environment.", { marker })}\n`
		);
		return null;
	}
	args.values.set("--broker", services);
	agentBrokerRuns.add(args);
	ctx.io.err(
		`${tf("AI agent session detected ({marker}); running through the credential broker with {services}.", { marker, services: services.join(", ") })}\n`
	);
	return null;
}
