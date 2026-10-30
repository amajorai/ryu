// `ryu disconnect <agent>`: remove the Ryu MCP entry that `connect` added.

import { tf } from "../i18n/translate.ts";
import {
	BIN,
	type ConnectionTarget,
	connectionTarget,
	requireAgent,
	writeJson,
} from "./agentCommands-shared.ts";
import {
	type AgentTarget,
	type ConnectionRecord,
	deleteConfigFile,
	type EntrySpec,
	isRecordedEntry,
	type JsonValue,
	loadConnectState,
	MCP_SERVER_NAME,
	readConfigFile,
	readEntry,
	removeEntry,
	sameEntry,
	saveConnectState,
	UnsupportedConfigError,
	writeFileAtomic,
} from "./agentConnect.ts";
import type { Command } from "./types.ts";

/** True when `current` is an entry Ryu wrote: the recorded one, or one equal to
 *  what `connect` would write now (for example pasted from `--print`). */
function isRyuOwned(
	agent: AgentTarget,
	current: JsonValue,
	record: ConnectionRecord | undefined,
	configPath: string,
	target: ConnectionTarget
): boolean {
	if (isRecordedEntry(current, record, configPath)) {
		return true;
	}
	const candidates: EntrySpec[] = [
		{ mcpUrl: target.mcpUrl, token: null, tokenMode: "env" },
	];
	if (target.token) {
		candidates.push({
			mcpUrl: target.mcpUrl,
			token: target.token,
			tokenMode: "inline",
		});
	}
	return candidates.some((spec) => sameEntry(current, agent.buildEntry(spec)));
}

export const disconnectCommand: Command = {
	name: "disconnect",
	summary: "Remove the Ryu MCP entry that 'connect' added to a coding agent",
	usage: "ryu disconnect <agent> [--force] [--dry-run]",
	run: async (ctx) => {
		const agent = requireAgent(
			ctx,
			`${BIN} disconnect <agent> [--force] [--dry-run]`
		);
		const target = connectionTarget(ctx);
		const configPath = agent.configPath(ctx.env, target.home);
		const state = loadConnectState(ctx.env);
		const record = state.agents[agent.id];
		const { [agent.id]: _dropped, ...remainingRecords } = state.agents;

		let text: string | null;
		let current: JsonValue | undefined;
		try {
			text = readConfigFile(configPath);
			current = readEntry(agent, text, configPath);
		} catch (error) {
			if (error instanceof UnsupportedConfigError) {
				throw new Error(
					`${error.message} Remove the '${MCP_SERVER_NAME}' MCP server from ${configPath} by hand.`
				);
			}
			throw error;
		}

		if (text === null || current === undefined) {
			if (!ctx.flags.dryRun && record) {
				saveConnectState(ctx.env, { ...state, agents: remainingRecords });
			}
			if (ctx.flags.json) {
				writeJson(ctx, { action: "absent", agent: agent.id, configPath });
			} else {
				ctx.io.out(
					`${tf("{label} has no Ryu MCP entry in {configPath}.", { label: agent.label, configPath })}\n`
				);
			}
			return 0;
		}

		if (
			!(
				ctx.flags.force ||
				isRyuOwned(agent, current, record, configPath, target)
			)
		) {
			throw new Error(
				`The '${MCP_SERVER_NAME}' MCP server in ${configPath} was changed after ${BIN} connect wrote it, or was added by something else. Re-run with --force to remove it anyway.`
			);
		}

		let next: string | null;
		try {
			// The created-file marker only applies to the file it was recorded for
			// (CLAUDE_CONFIG_DIR / CODEX_HOME / opencode.json(c) can change).
			const createdFile =
				record?.configPath === configPath && record.createdFile;
			next = removeEntry(agent, text, createdFile, configPath);
		} catch (error) {
			if (error instanceof UnsupportedConfigError) {
				throw new Error(
					`${error.message} Remove the '${MCP_SERVER_NAME}' MCP server from ${configPath} by hand.`
				);
			}
			throw error;
		}

		const summary = {
			action: next === null ? "delete-file" : "remove",
			agent: agent.id,
			configPath,
			dryRun: ctx.flags.dryRun,
		};
		if (ctx.flags.dryRun) {
			if (ctx.flags.json) {
				writeJson(ctx, summary);
			} else {
				ctx.io.out(
					next === null
						? `${tf("Dry run — would delete {configPath} ({BIN} created it and it holds nothing else).", { configPath, BIN })}\n`
						: `${tf("Dry run — would remove the '{MCP_SERVER_NAME}' MCP server from {configPath}.", { MCP_SERVER_NAME, configPath })}\n`
				);
			}
			return 0;
		}

		if (next === null) {
			deleteConfigFile(configPath);
		} else {
			writeFileAtomic(configPath, next);
		}
		saveConnectState(ctx.env, { ...state, agents: remainingRecords });
		if (ctx.flags.json) {
			writeJson(ctx, summary);
		} else {
			ctx.io.out(
				`${tf("Disconnected {label}: removed the '{MCP_SERVER_NAME}' MCP server from {configPath}.", { label: agent.label, MCP_SERVER_NAME, configPath })}\n`
			);
		}
		return 0;
	},
};
