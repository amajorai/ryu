// `ryu connect <agent>`: add Ryu's MCP entry to a coding agent's config.

import { tf } from "../i18n/translate.ts";
import {
	BIN,
	connectionTarget,
	modeLabel,
	printSnippet,
	requireAgent,
	writeJson,
} from "./agentCommands-shared.ts";
import {
	type ConnectionRecord,
	describeEntry,
	type EntrySpec,
	entryHash,
	fileMode,
	isRecordedEntry,
	type JsonObject,
	type JsonValue,
	loadConnectState,
	MCP_SERVER_NAME,
	readConfigFile,
	readEntry,
	redactToken,
	renderSnippet,
	sameEntry,
	saveConnectState,
	TOKEN_ENV_VAR,
	type TokenMode,
	UnsupportedConfigError,
	writeEntry,
	writeFileAtomic,
} from "./agentConnect.ts";
import type { CliContext, Command } from "./types.ts";

type ConnectAction = "create" | "update" | "unchanged";

function decideConnect(
	ctx: CliContext,
	current: JsonValue | undefined,
	entry: JsonObject,
	record: ConnectionRecord | undefined,
	configPath: string
): ConnectAction {
	if (current === undefined) {
		return "create";
	}
	if (sameEntry(current, entry)) {
		return "unchanged";
	}
	if (isRecordedEntry(current, record, configPath) || ctx.flags.force) {
		return "update";
	}
	const url = describeEntry(current).url ?? "unknown URL";
	throw new Error(
		`${configPath} already has an MCP server named '${MCP_SERVER_NAME}' that ${BIN} did not add (it points at ${url}). Re-run with --force to replace it, or with --print to see Ryu's entry.`
	);
}

const connectUsage = `${BIN} connect <agent> [--agent <ryu-agent>] [--token-env] [--force] [--dry-run] [--print]`;

export const connectCommand: Command = {
	name: "connect",
	summary: "Add Ryu's MCP tools to a coding agent (claude-code, codex, …)",
	usage: "ryu connect <agent> [--token-env] [--print]",
	run: async (ctx) => {
		const agent = requireAgent(ctx, connectUsage);
		const target = connectionTarget(ctx);
		const tokenMode: TokenMode = ctx.flags.tokenEnv ? "env" : "inline";
		if (tokenMode === "inline" && !target.token) {
			throw new Error(
				`No node token is available for ${target.coreUrl}. Start Ryu once so it creates its node token, set ${TOKEN_ENV_VAR}, or use --token-env.`
			);
		}
		const spec: EntrySpec = {
			mcpUrl: target.mcpUrl,
			token: target.token,
			tokenMode,
		};
		const entry = agent.buildEntry(spec);
		const configPath = agent.configPath(ctx.env, target.home);
		if (ctx.flags.print) {
			return printSnippet(
				ctx,
				agent,
				entry,
				configPath,
				tokenMode,
				null,
				target.token
			);
		}

		let text: string | null;
		let current: JsonValue | undefined;
		let next: string;
		const state = loadConnectState(ctx.env);
		const record = state.agents[agent.id];
		let action: ConnectAction;
		try {
			text = readConfigFile(configPath);
			current = readEntry(agent, text, configPath);
			action = decideConnect(ctx, current, entry, record, configPath);
			next =
				action === "unchanged"
					? (text ?? "")
					: writeEntry(agent, text, entry, configPath);
		} catch (error) {
			if (error instanceof UnsupportedConfigError) {
				return printSnippet(
					ctx,
					agent,
					entry,
					configPath,
					tokenMode,
					error.message,
					target.token
				);
			}
			throw error;
		}

		const summary = {
			action,
			agent: agent.id,
			configPath,
			dryRun: ctx.flags.dryRun,
			mcpUrl: target.mcpUrl,
			tokenMode,
		};
		if (ctx.flags.dryRun) {
			if (ctx.flags.json) {
				writeJson(ctx, {
					...summary,
					snippet: redactToken(renderSnippet(agent, entry), target.token),
				});
				return 0;
			}
			const verb =
				action === "create"
					? "add"
					: action === "update"
						? "replace"
						: "leave unchanged";
			ctx.io.out(
				tf(
					"Dry run — would {verb} the '{MCP_SERVER_NAME}' MCP server in {configPath}:\n{snippet}",
					{
						verb,
						MCP_SERVER_NAME,
						configPath,
						snippet: redactToken(renderSnippet(agent, entry), target.token),
					}
				)
			);
			return 0;
		}

		const priorMode = fileMode(configPath);
		if (action !== "unchanged") {
			writeFileAtomic(configPath, next);
		}
		const createdFile =
			text === null ||
			(record?.configPath === configPath && record.createdFile);
		state.agents[agent.id] = {
			configPath,
			createdFile,
			entryHash: entryHash(entry),
			mcpUrl: target.mcpUrl,
			tokenMode,
		};
		saveConnectState(ctx.env, state);

		if (ctx.flags.json) {
			writeJson(ctx, summary);
			return 0;
		}
		const done =
			action === "unchanged"
				? `${agent.label} is already connected to Ryu`
				: `Connected ${agent.label} to Ryu`;
		ctx.io.out(
			`${tf(
				"{done}: MCP server '{MCP_SERVER_NAME}' → {mcpUrl}\nConfig: {configPath}\n{reloadHint}",
				{
					done,
					MCP_SERVER_NAME,
					mcpUrl: target.mcpUrl,
					configPath,
					reloadHint: agent.reloadHint,
				}
			)}\n`
		);
		if (tokenMode === "inline") {
			const groupReadable = priorMode !== null && (priorMode & 0o077) !== 0;
			ctx.io.err(
				`${tf(
					// biome-ignore lint/suspicious/noTemplateCurlyInString: ICU message with a literal dollar sign before the env var placeholder.
					"Note: the Ryu node token is stored in plain text in {configPath} ({mode}).{groupWarning} Use --token-env to reference ${TOKEN_ENV_VAR} instead.",
					{
						configPath,
						mode: modeLabel(priorMode),
						groupWarning: groupReadable
							? " That file is readable by other users; consider chmod 600."
							: "",
						TOKEN_ENV_VAR,
					}
				)}\n`
			);
		} else {
			ctx.io.err(
				`${tf(
					"Note: {label} must be started with {TOKEN_ENV_VAR} set to the node token.",
					{ label: agent.label, TOKEN_ENV_VAR }
				)}\n`
			);
		}
		return 0;
	},
};
