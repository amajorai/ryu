// Shared pieces of the `ryu connect`/`disconnect`/`doctor agents` command layer
// (see agentCommands.ts): the binary name, Core URL + node token resolution, and
// the manual-paste snippet fallback.

import { resolveLocalNodeToken } from "@ryuhq/core-client/node-token";
import { cliUserHome } from "../core/cliStatePath.ts";
import { tf } from "../i18n/translate.ts";
import {
	type AgentTarget,
	DEFAULT_RYU_AGENT,
	findAgent,
	type JsonObject,
	mcpEndpointUrl,
	redactToken,
	renderSnippet,
	supportedAgents,
	TOKEN_ENV_VAR,
	type TokenMode,
} from "./agentConnect.ts";
import { type CliContext, UsageError } from "./types.ts";

/** The installed binary name, used in every hint a user may copy. */
export const BIN = "ryu-cli";
export const PROBE_TIMEOUT_MS = 3000;
/** The pre-negotiation MCP revision Core accepts on a header-less initialize. */
export const PROBE_PROTOCOL_VERSION = "2025-06-18";

function agentList(): string {
	return supportedAgents()
		.map((agent) => agent.id)
		.join(", ");
}

export function requireAgent(ctx: CliContext, usage: string): AgentTarget {
	const id = ctx.args[0];
	if (!id) {
		throw new UsageError(`Usage: ${usage}\nAgents: ${agentList()}`);
	}
	const agent = findAgent(id);
	if (!agent) {
		throw new UsageError(
			`Unknown coding agent '${id}'. Supported: ${agentList()}.`
		);
	}
	return agent;
}

export interface ConnectionTarget {
	coreUrl: string;
	home: string;
	mcpUrl: string;
	ryuAgent: string;
	token: string | null;
}

/** Core URL from `--node`/`RYU_CORE_URL` (the dispatcher's target), and the
 *  node token resolved like every other local surface: `RYU_CORE_TOKEN`, then
 *  `RYU_TOKEN`, then the token Core minted in its data dir (loopback URLs only). */
export function connectionTarget(ctx: CliContext): ConnectionTarget {
	const coreUrl = ctx.target.url;
	const ryuAgent = ctx.flags.agent?.trim() || DEFAULT_RYU_AGENT;
	return {
		coreUrl,
		home: cliUserHome(ctx.env),
		mcpUrl: mcpEndpointUrl(coreUrl, ryuAgent),
		ryuAgent,
		token: ctx.target.token ?? resolveLocalNodeToken(coreUrl),
	};
}

export function modeLabel(mode: number | null): string {
	return mode === null ? "new file, 0600" : `mode ${mode.toString(8)}`;
}

export function writeJson(ctx: CliContext, value: unknown): void {
	ctx.io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Print the agent's snippet for manual pasting. Used by --print, and as the
 *  fallback when a config exists but cannot be edited safely. */
export function printSnippet(
	ctx: CliContext,
	agent: AgentTarget,
	entry: JsonObject,
	configPath: string,
	tokenMode: TokenMode,
	reason: string | null,
	token: string | null
): number {
	// Only an explicit --print shows the token. The fallback (an uneditable
	// config, possibly under --dry-run or in a CI log) prints it redacted.
	const redacted = !ctx.flags.print && tokenMode === "inline";
	const full = renderSnippet(agent, entry);
	const snippet = redacted ? redactToken(full, token) : full;
	if (ctx.flags.json) {
		writeJson(ctx, {
			agent: agent.id,
			configPath,
			format: agent.format,
			printed: true,
			reason,
			snippet,
			tokenMode,
		});
	} else {
		if (reason) {
			ctx.io.err(
				`${tf("{reason}\nNothing was written. Add this to {configPath}:", { reason, configPath })}\n`
			);
		} else {
			ctx.io.err(`${tf("Add this to {configPath}:", { configPath })}\n`);
		}
		ctx.io.out(snippet);
		if (redacted) {
			ctx.io.err(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: ICU message with a literal dollar sign before the env var placeholder.
				`${tf("The node token is redacted. Run {BIN} connect {id} --print to include it, or use --token-env to reference ${TOKEN_ENV_VAR} instead.", { BIN, id: agent.id, TOKEN_ENV_VAR })}\n`
			);
		} else if (tokenMode === "inline") {
			ctx.io.err(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: ICU message with a literal dollar sign before the env var placeholder.
				`${tf("This snippet contains your Ryu node token. Use --token-env to reference ${TOKEN_ENV_VAR} instead.", { TOKEN_ENV_VAR })}\n`
			);
		}
	}
	return reason ? 1 : 0;
}
