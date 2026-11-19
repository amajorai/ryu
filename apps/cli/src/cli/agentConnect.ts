// Register Ryu as an MCP server in an external coding agent's USER-level config
// (`ryu connect <agent>` / `ryu disconnect <agent>` / `ryu doctor agents`).
//
// Every agent gets the same thing: Core's Streamable HTTP MCP endpoint
// (`POST <core>/mcp/<ryu-agent-id>`, see `mcp_http` in apps/core/src/server/mod.rs)
// with the node bearer in an `Authorization` header. Only the file location and
// the key names differ per agent:
//
//   claude-code  ~/.claude.json            mcpServers.ryu {type:"http", url, headers}
//   codex        ~/.codex/config.toml      [mcp_servers.ryu] url + http_headers
//                                          (or bearer_token_env_var)
//   cursor       ~/.cursor/mcp.json        mcpServers.ryu {url, headers}
//   opencode     ~/.config/opencode/opencode.json  mcp.ryu {type:"remote", url, enabled, headers}
//   gemini       ~/.gemini/settings.json   mcpServers.ryu {httpUrl, headers}
//
// Reversibility follows the hash-guarded pattern of the Desktop model-provider
// setup (apps/desktop/src-tauri/src/cli_setup.rs): `connect` records a SHA-256 of
// the exact entry it wrote (never the token itself) in the CLI state dir, and
// `disconnect` removes the entry only while it still matches that record. An entry
// named `ryu` that Ryu did not write is never replaced or removed without --force.
//
// Everything that decides WHAT to write is a pure function over strings so the
// merge/removal rules are unit-tested per format without touching a real home.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	containerNotObject,
	notJsonObject,
	notPlainJson,
} from "./agentConnect-errors.ts";
import {
	parseToml,
	removeTomlEntry,
	renderTomlEntry,
	setTomlEntry,
	tomlRyuEntry,
} from "./agentConnect-toml.ts";
import {
	type AgentTarget,
	type EntrySpec,
	type Env,
	isJsonObject,
	type JsonObject,
	type JsonValue,
	MCP_SERVER_NAME,
	TOKEN_ENV_VAR,
	type TokenMode,
} from "./agentConnect-types.ts";

export { UnsupportedConfigError } from "./agentConnect-errors.ts";
export {
	type ConnectionRecord,
	type ConnectState,
	connectStatePath,
	deleteConfigFile,
	fileMode,
	isRecordedEntry,
	loadConnectState,
	readConfigFile,
	saveConnectState,
	writeFileAtomic,
} from "./agentConnect-state.ts";
export { renderTomlEntry } from "./agentConnect-toml.ts";
export {
	type AgentTarget,
	type ConfigFormat,
	canonicalJson,
	DEFAULT_RYU_AGENT,
	type EntrySpec,
	entryHash,
	type JsonObject,
	type JsonValue,
	MCP_SERVER_NAME,
	sameEntry,
	TOKEN_ENV_VAR,
	type TokenMode,
} from "./agentConnect-types.ts";

function bearer(spec: EntrySpec, envReference: string): string {
	if (spec.tokenMode === "env") {
		return `Bearer ${envReference}`;
	}
	if (!spec.token) {
		throw new Error("No node token is available to write.");
	}
	return `Bearer ${spec.token}`;
}

function absoluteEnvDir(env: Env, key: string): string | null {
	const value = env[key]?.trim();
	return value && isAbsolute(value) ? value : null;
}

const AGENTS: AgentTarget[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		binaries: ["claude"],
		format: "json",
		containerKey: "mcpServers",
		// `claude mcp add --scope user` writes ~/.claude.json, or
		// $CLAUDE_CONFIG_DIR/.claude.json when that is set.
		configPath: (env, home) =>
			join(absoluteEnvDir(env, "CLAUDE_CONFIG_DIR") ?? home, ".claude.json"),
		buildEntry: (spec) => ({
			type: "http",
			url: spec.mcpUrl,
			headers: { Authorization: bearer(spec, `\${${TOKEN_ENV_VAR}}`) },
		}),
		reloadHint: "Start a new Claude Code session (or run /mcp) to load it.",
	},
	{
		id: "codex",
		label: "Codex",
		binaries: ["codex"],
		format: "toml",
		containerKey: "mcp_servers",
		configPath: (env, home) =>
			join(
				absoluteEnvDir(env, "CODEX_HOME") ?? join(home, ".codex"),
				"config.toml"
			),
		buildEntry: (spec): JsonObject =>
			spec.tokenMode === "env"
				? { url: spec.mcpUrl, bearer_token_env_var: TOKEN_ENV_VAR }
				: {
						url: spec.mcpUrl,
						http_headers: { Authorization: bearer(spec, "") },
					},
		reloadHint: "Start a new Codex session to load it.",
	},
	{
		id: "cursor",
		label: "Cursor",
		binaries: ["cursor", "cursor-agent"],
		format: "json",
		containerKey: "mcpServers",
		configPath: (_env, home) => join(home, ".cursor", "mcp.json"),
		buildEntry: (spec) => ({
			url: spec.mcpUrl,
			headers: { Authorization: bearer(spec, `\${env:${TOKEN_ENV_VAR}}`) },
		}),
		reloadHint:
			"Reload Cursor (or toggle the server in Settings → MCP) to load it.",
	},
	{
		id: "opencode",
		label: "opencode",
		binaries: ["opencode"],
		format: "json",
		containerKey: "mcp",
		configPath: (env, home) => {
			const dir = join(
				absoluteEnvDir(env, "XDG_CONFIG_HOME") ?? join(home, ".config"),
				"opencode"
			);
			const json = join(dir, "opencode.json");
			const jsonc = join(dir, "opencode.jsonc");
			// Same preference as Desktop's provider setup: an existing
			// opencode.jsonc is the file opencode reads when no .json exists.
			return !existsSync(json) && existsSync(jsonc) ? jsonc : json;
		},
		buildEntry: (spec) => ({
			type: "remote",
			url: spec.mcpUrl,
			enabled: true,
			headers: { Authorization: bearer(spec, `{env:${TOKEN_ENV_VAR}}`) },
		}),
		reloadHint: "Restart opencode to load it.",
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binaries: ["gemini"],
		format: "json",
		containerKey: "mcpServers",
		configPath: (_env, home) => join(home, ".gemini", "settings.json"),
		buildEntry: (spec) => ({
			httpUrl: spec.mcpUrl,
			headers: { Authorization: bearer(spec, `\${${TOKEN_ENV_VAR}}`) },
		}),
		reloadHint: "Restart Gemini CLI to load it.",
	},
];

/** Every supported agent, in display order. */
export function supportedAgents(): readonly AgentTarget[] {
	return AGENTS;
}

/** Look up an agent by id (case-insensitive). */
export function findAgent(id: string): AgentTarget | undefined {
	const wanted = id.trim().toLowerCase();
	return AGENTS.find((agent) => agent.id === wanted);
}

/** `<core>/mcp/<agent>` without a doubled slash. */
export function mcpEndpointUrl(coreUrl: string, ryuAgent: string): string {
	return `${coreUrl.replace(/\/+$/, "")}/mcp/${encodeURIComponent(ryuAgent)}`;
}

// ── JSON configs ───────────────────────────────────────────────────────────────

function parseJsonDocument(text: string | null, label: string): JsonObject {
	if (text === null || text.trim() === "") {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw notPlainJson(label);
	}
	if (!isJsonObject(parsed)) {
		throw notJsonObject(label);
	}
	return parsed;
}

function jsonContainer(
	doc: JsonObject,
	containerKey: string,
	label: string
): JsonObject | undefined {
	const container = doc[containerKey];
	if (container === undefined) {
		return undefined;
	}
	if (!isJsonObject(container)) {
		throw containerNotObject(label, containerKey);
	}
	return container;
}

function detectIndent(text: string | null): string {
	const match = text?.match(/^([ \t]+)"/m);
	return match?.[1] ?? "  ";
}

function stringifyLike(doc: JsonObject, original: string | null): string {
	const body = JSON.stringify(doc, null, detectIndent(original));
	const withNewline =
		original === null || original.endsWith("\n") ? `${body}\n` : body;
	// Keep a CRLF file CRLF. JSON.stringify never emits a raw newline inside a
	// string, so every "\n" here is layout.
	return original?.includes("\r\n")
		? withNewline.replaceAll("\n", "\r\n")
		: withNewline;
}

/** JSONC → JSON: drop comments and trailing commas outside strings. Used only to
 *  READ an entry (doctor); a commented file is never rewritten. */
export function stripJsonComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				j += text[j] === "\\" ? 2 : 1;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") {
				i++;
			}
		} else if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The `ryu` entry of a JSON config that may contain comments (doctor only). */
export function readEntryLenient(
	agent: AgentTarget,
	text: string | null,
	label = agent.label
): JsonValue | undefined {
	if (agent.format === "toml" || text === null) {
		return readEntry(agent, text, label);
	}
	return readEntry(agent, stripJsonComments(text), label);
}

// ── Format-independent entry operations ────────────────────────────────────────

/** The current `ryu` entry in a config's text, or undefined when absent. */
export function readEntry(
	agent: AgentTarget,
	text: string | null,
	label = agent.label
): JsonValue | undefined {
	if (agent.format === "toml") {
		return tomlRyuEntry(parseToml(text, label));
	}
	const doc = parseJsonDocument(text, label);
	return jsonContainer(doc, agent.containerKey, label)?.[MCP_SERVER_NAME];
}

/** The config text with the `ryu` entry set to `entry`; every other entry and
 *  setting is preserved. */
export function writeEntry(
	agent: AgentTarget,
	text: string | null,
	entry: JsonObject,
	label = agent.label
): string {
	if (agent.format === "toml") {
		return setTomlEntry(text, entry, label);
	}
	const doc = parseJsonDocument(text, label);
	const container = jsonContainer(doc, agent.containerKey, label);
	if (container) {
		container[MCP_SERVER_NAME] = entry;
	} else {
		doc[agent.containerKey] = { [MCP_SERVER_NAME]: entry };
	}
	return stringifyLike(doc, text);
}

/** The config text without the `ryu` entry, or null when the file should be
 *  deleted (Ryu created it and nothing else remains in it). */
export function removeEntry(
	agent: AgentTarget,
	text: string,
	createdFile: boolean,
	label = agent.label
): string | null {
	if (agent.format === "toml") {
		const result = removeTomlEntry(text, label);
		return createdFile && result.trim() === "" ? null : result;
	}
	const doc = parseJsonDocument(text, label);
	const container = jsonContainer(doc, agent.containerKey, label);
	if (!(container && MCP_SERVER_NAME in container)) {
		return text;
	}
	const remaining = Object.fromEntries(
		Object.entries(container).filter(([key]) => key !== MCP_SERVER_NAME)
	);
	if (
		createdFile &&
		Object.keys(remaining).length === 0 &&
		Object.keys(doc).length === 1
	) {
		return null;
	}
	doc[agent.containerKey] = remaining;
	return stringifyLike(doc, text);
}

/** A pasteable snippet in the agent's own format. */
export function renderSnippet(agent: AgentTarget, entry: JsonObject): string {
	if (agent.format === "toml") {
		return `${renderTomlEntry(entry)}\n`;
	}
	return `${JSON.stringify({ [agent.containerKey]: { [MCP_SERVER_NAME]: entry } }, null, 2)}\n`;
}

/** Replace an inline token with a placeholder so previews never print it. */
export function redactToken(text: string, token: string | null): string {
	return token ? text.split(token).join("<node token>") : text;
}

// ── Reading an existing entry back (doctor) ────────────────────────────────────

export interface EntryInfo {
	/** The inline bearer, when the entry carries one literally. */
	inlineToken: string | null;
	tokenMode: TokenMode | "none";
	url: string | null;
}

const ENV_REFERENCE = /\$\{|\{env:|^\$[A-Za-z_]/;

/** The URL and credential an existing `ryu` entry uses, across all formats. */
export function describeEntry(entry: JsonValue | undefined): EntryInfo {
	if (!isJsonObject(entry)) {
		return { inlineToken: null, tokenMode: "none", url: null };
	}
	const urlValue = entry.url ?? entry.httpUrl;
	const url = typeof urlValue === "string" ? urlValue : null;
	if (typeof entry.bearer_token_env_var === "string") {
		return { inlineToken: null, tokenMode: "env", url };
	}
	// Codex: `env_http_headers` maps a header to the variable holding its value.
	if (
		isJsonObject(entry.env_http_headers) &&
		Object.keys(entry.env_http_headers).some(
			(key) => key.toLowerCase() === "authorization"
		)
	) {
		return { inlineToken: null, tokenMode: "env", url };
	}
	const headers = isJsonObject(entry.headers)
		? entry.headers
		: isJsonObject(entry.http_headers)
			? entry.http_headers
			: null;
	const auth = headers?.Authorization ?? headers?.authorization;
	if (typeof auth !== "string") {
		return { inlineToken: null, tokenMode: "none", url };
	}
	const credential = auth.replace(/^Bearer\s+/i, "");
	if (ENV_REFERENCE.test(credential)) {
		return { inlineToken: null, tokenMode: "env", url };
	}
	return { inlineToken: credential, tokenMode: "inline", url };
}
