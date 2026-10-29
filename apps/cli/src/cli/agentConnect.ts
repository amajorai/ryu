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

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { cliStatePath } from "../core/cliStatePath.ts";

/** The MCP server name Ryu registers under in every agent's config. */
export const MCP_SERVER_NAME = "ryu";
/** The variable an env-referenced entry reads the node token from. */
export const TOKEN_ENV_VAR = "RYU_CORE_TOKEN";
/** The Ryu agent the MCP endpoint is scoped to when `--agent` is not given. */
export const DEFAULT_RYU_AGENT = "ryu";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
export interface JsonObject {
	[key: string]: JsonValue;
}

export type ConfigFormat = "json" | "toml";
export type TokenMode = "inline" | "env";
type Env = Readonly<Record<string, string | undefined>>;

/** What to point an agent at. `token` is required for inline mode only. */
export interface EntrySpec {
	mcpUrl: string;
	token: string | null;
	tokenMode: TokenMode;
}

export interface AgentTarget {
	/** Names probed on PATH by `ryu doctor agents`. */
	binaries: string[];
	buildEntry: (spec: EntrySpec) => JsonObject;
	/** Resolve the user-level config file for this agent. */
	configPath: (env: Env, home: string) => string;
	/** JSON configs only: the top-level key holding the server map. */
	containerKey: string;
	format: ConfigFormat;
	id: string;
	label: string;
	/** What the user does after connecting so the agent loads the server. */
	reloadHint: string;
}

/** Thrown when a config exists but cannot be edited safely (comments in JSON,
 *  an inline TOML entry, a non-object server map). The command then falls back
 *  to printing the snippet for the user to paste. */
export class UnsupportedConfigError extends Error {}

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

// ── Canonical comparison ───────────────────────────────────────────────────────

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (isJsonObject(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys(value[key])])
		);
	}
	return value;
}

/** Key-order-independent JSON text, for equality and hashing. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value)) ?? "null";
}

/** The SHA-256 recorded for an entry Ryu wrote. Never the token itself. */
export function entryHash(entry: unknown): string {
	return createHash("sha256").update(canonicalJson(entry)).digest("hex");
}

export function sameEntry(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
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
		throw new UnsupportedConfigError(
			`${label} is not plain JSON (it may contain comments), so it cannot be edited safely.`
		);
	}
	if (!isJsonObject(parsed)) {
		throw new UnsupportedConfigError(`${label} must be a JSON object.`);
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
		throw new UnsupportedConfigError(
			`${label}: "${containerKey}" is not an object, so it cannot be edited safely.`
		);
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

// ── TOML configs (Codex) ───────────────────────────────────────────────────────
//
// No TOML writer is a CLI dependency, and a re-serialized config.toml would lose
// the user's comments and layout. Instead the `[mcp_servers.ryu]` table is
// spliced as text and the result is re-parsed with Bun's TOML parser: the edit is
// accepted only if the parsed document equals the original with exactly the Ryu
// entry changed. Anything the splice cannot express (an inline `ryu = {…}` entry,
// a root `mcp_servers = {…}` table) is refused as unsupported.

// One key of a dotted table name: bare, "basic" (with escapes), or 'literal'.
// Quoted keys may hold any character, e.g. Codex's own `[projects."/path/to/x"]`.
const TOML_KEY_PART = `(?:[A-Za-z0-9_-]+|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`;
const TOML_HEADER = new RegExp(
	`^\\s*\\[\\[?\\s*${TOML_KEY_PART}(?:\\s*\\.\\s*${TOML_KEY_PART})*\\s*\\]\\]?\\s*(?:#.*)?$`
);
const TOML_RYU_HEADER = new RegExp(
	`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')\\s*(?:\\]|\\.)`
);
const TOML_COMMENT_OR_BLANK = /^\s*(?:#.*)?$/;
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function parseToml(text: string | null, label: string): JsonObject {
	if (text === null || text.trim() === "") {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch (error) {
		throw new UnsupportedConfigError(
			`${label} is not valid TOML (${String(error)}), so it cannot be edited safely.`
		);
	}
	if (!isJsonObject(parsed)) {
		throw new UnsupportedConfigError(`${label} is not a TOML table.`);
	}
	return parsed;
}

function tomlKey(key: string): string {
	return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function tomlScalar(value: JsonValue): string {
	if (typeof value === "string") {
		// JSON string escapes are a subset of TOML basic-string escapes.
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (isJsonObject(value)) {
		const pairs = Object.entries(value).map(
			([key, inner]) => `${tomlKey(key)} = ${tomlScalar(inner)}`
		);
		return `{ ${pairs.join(", ")} }`;
	}
	throw new Error("Unsupported TOML value in the Ryu MCP entry.");
}

/** The `[mcp_servers.ryu]` table text for an entry (no trailing newline). */
export function renderTomlEntry(entry: JsonObject): string {
	const lines = [`[mcp_servers.${MCP_SERVER_NAME}]`];
	for (const [key, value] of Object.entries(entry)) {
		lines.push(`${tomlKey(key)} = ${tomlScalar(value)}`);
	}
	return lines.join("\n");
}

function tomlRyuEntry(doc: JsonObject): JsonValue | undefined {
	const servers = doc.mcp_servers;
	return isJsonObject(servers) ? servers[MCP_SERVER_NAME] : undefined;
}

/** The document without the Ryu entry (and without an emptied server map). */
function withoutTomlRyu(doc: JsonObject): JsonObject {
	const servers = doc.mcp_servers;
	if (!isJsonObject(servers)) {
		return doc;
	}
	const rest = Object.fromEntries(
		Object.entries(servers).filter(([key]) => key !== MCP_SERVER_NAME)
	);
	const { mcp_servers: _servers, ...others } = doc;
	return Object.keys(rest).length === 0
		? others
		: { ...others, mcp_servers: rest };
}

interface TomlSplit {
	eol: string;
	/** Index in `kept` where the first Ryu table started, or -1. */
	insertAt: number;
	kept: string[];
	removedAny: boolean;
}

/** Drop every `[mcp_servers.ryu]` / `[mcp_servers.ryu.*]` table. Comment lines
 *  that end a dropped table are kept, since they introduce the NEXT table. */
function splitOutRyuTables(text: string): TomlSplit {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let dropped: string[] = [];
	let inRyu = false;
	let insertAt = -1;
	let removedAny = false;
	const flushDropped = () => {
		// Trailing comment run of the dropped table: keep it (minus the blank
		// lines that separated it from the dropped keys).
		let start = dropped.length;
		while (start > 0 && TOML_COMMENT_OR_BLANK.test(dropped[start - 1] ?? "")) {
			start--;
		}
		const tail = dropped.slice(start);
		const firstComment = tail.findIndex((line) => line.trim() !== "");
		if (firstComment !== -1) {
			kept.push(...tail.slice(firstComment));
		}
		dropped = [];
	};
	for (const line of lines) {
		if (TOML_HEADER.test(line)) {
			const isRyu = TOML_RYU_HEADER.test(line);
			if (inRyu && !isRyu) {
				flushDropped();
			}
			if (isRyu && insertAt === -1) {
				insertAt = kept.length;
			}
			inRyu = isRyu;
		}
		if (inRyu) {
			dropped.push(line);
			removedAny = true;
		} else {
			kept.push(line);
		}
	}
	if (inRyu) {
		flushDropped();
	}
	return { eol, insertAt, kept, removedAny };
}

function trimTrailingBlankLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && (lines[end - 1] ?? "").trim() === "") {
		end--;
	}
	return lines.slice(0, end);
}

/**
 * Whether `mcp_servers` is set by a root-level key (`mcp_servers = { … }` or a
 * dotted `mcp_servers.git = …`) before the first table header. TOML forbids
 * adding a `[mcp_servers.ryu]` table to it; Bun's parser accepts that, but
 * Codex's would reject the file, so the check cannot rely on a re-parse.
 */
function definesServersAtRoot(text: string): boolean {
	for (const line of text.split(/\r?\n/)) {
		if (TOML_HEADER.test(line)) {
			return false;
		}
		if (/^\s*mcp_servers\s*[.=]/.test(line)) {
			return true;
		}
	}
	return false;
}

function joinToml(lines: string[], eol: string): string {
	const trimmed = trimTrailingBlankLines(lines);
	return trimmed.length === 0 ? "" : `${trimmed.join(eol)}${eol}`;
}

function setTomlEntry(
	original: string | null,
	entry: JsonObject,
	label: string
): string {
	const before = parseToml(original, label);
	if (definesServersAtRoot(original ?? "")) {
		throw new UnsupportedConfigError(
			`${label} defines mcp_servers with a root key, which a [mcp_servers.${MCP_SERVER_NAME}] table cannot extend.`
		);
	}
	const block = renderTomlEntry(entry).split("\n");
	const split = splitOutRyuTables(original ?? "");
	if (tomlRyuEntry(before) !== undefined && !split.removedAny) {
		throw new UnsupportedConfigError(
			`${label} defines mcp_servers.${MCP_SERVER_NAME} inline, so it cannot be replaced safely.`
		);
	}
	let lines: string[];
	if (split.insertAt === -1) {
		const base = trimTrailingBlankLines(split.kept);
		lines = base.length === 0 ? block : [...base, "", ...block];
	} else {
		const next = split.kept[split.insertAt];
		const needsGap = next !== undefined && next.trim() !== "";
		lines = [
			...split.kept.slice(0, split.insertAt),
			...block,
			...(needsGap ? [""] : []),
			...split.kept.slice(split.insertAt),
		];
	}
	const result = joinToml(lines, split.eol);
	const after = parseToml(result, label);
	if (
		!(
			sameEntry(tomlRyuEntry(after), entry) &&
			sameEntry(withoutTomlRyu(after), withoutTomlRyu(before))
		)
	) {
		throw new UnsupportedConfigError(
			`${label} has a layout Ryu cannot edit without side effects.`
		);
	}
	return result;
}

function removeTomlEntry(original: string, label: string): string {
	const before = parseToml(original, label);
	const split = splitOutRyuTables(original);
	if (!split.removedAny) {
		if (tomlRyuEntry(before) !== undefined) {
			throw new UnsupportedConfigError(
				`${label} defines mcp_servers.${MCP_SERVER_NAME} inline, so it cannot be removed safely.`
			);
		}
		return original;
	}
	const result = joinToml(split.kept, split.eol);
	const after = parseToml(result, label);
	if (
		tomlRyuEntry(after) !== undefined ||
		!sameEntry(withoutTomlRyu(after), withoutTomlRyu(before))
	) {
		throw new UnsupportedConfigError(
			`${label} has a layout Ryu cannot edit without side effects.`
		);
	}
	return result;
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

// ── Ownership state ────────────────────────────────────────────────────────────

const connectionRecordSchema = z.object({
	configPath: z.string(),
	createdFile: z.boolean(),
	entryHash: z.string(),
	mcpUrl: z.string(),
	tokenMode: z.enum(["inline", "env"]),
});
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;

const connectStateSchema = z.object({
	version: z.literal(1),
	agents: z.record(z.string(), connectionRecordSchema).catch(() => ({})),
});
export type ConnectState = z.infer<typeof connectStateSchema>;

function emptyState(): ConnectState {
	return { version: 1, agents: {} };
}

/** `<data dir>/state/cli/agent-connect.json` — which entries Ryu wrote. */
export function connectStatePath(env: Env): string {
	return cliStatePath("agent-connect.json", env);
}

export function loadConnectState(env: Env): ConnectState {
	try {
		const raw: unknown = JSON.parse(
			readFileSync(connectStatePath(env), "utf8")
		);
		const parsed = connectStateSchema.safeParse(raw);
		return parsed.success ? parsed.data : emptyState();
	} catch {
		return emptyState();
	}
}

export function saveConnectState(env: Env, state: ConnectState): void {
	writeFileAtomic(connectStatePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

/** Whether `current` is the entry Ryu recorded for this agent and path. */
export function isRecordedEntry(
	current: JsonValue | undefined,
	record: ConnectionRecord | undefined,
	configPath: string
): boolean {
	return (
		current !== undefined &&
		record !== undefined &&
		record.configPath === configPath &&
		entryHash(current) === record.entryHash
	);
}

// ── File IO ────────────────────────────────────────────────────────────────────

/** Read a config file, or null when it does not exist. A symlinked dotfile is
 *  followed; a directory or other non-file is refused. */
export function readConfigFile(path: string): string | null {
	if (!existsSync(path)) {
		return null;
	}
	const real = realpathSync(path);
	if (!statSync(real).isFile()) {
		throw new UnsupportedConfigError(`${path} is not a regular file.`);
	}
	try {
		// Fatal: a lossy decode would turn invalid bytes into U+FFFD and the
		// rewrite would then corrupt them in the user's file.
		return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real));
	} catch {
		throw new UnsupportedConfigError(
			`${path} is not valid UTF-8, so it cannot be edited safely.`
		);
	}
}

/** Follow a symlink chain to the file it names, even when that file does not
 *  exist yet (a dangling dotfile link), so writes land on the target and the
 *  link itself is kept. */
function resolveLinkTarget(path: string): string {
	let current = path;
	for (let hops = 0; hops < 40; hops++) {
		let isLink: boolean;
		try {
			isLink = lstatSync(current).isSymbolicLink();
		} catch {
			return current;
		}
		if (!isLink) {
			return current;
		}
		current = resolve(dirname(current), readlinkSync(current));
	}
	throw new UnsupportedConfigError(`${path} is a symlink loop.`);
}

/** Mode bits of an existing file, or null. */
export function fileMode(path: string): number | null {
	if (!existsSync(path)) {
		return null;
	}
	return statSync(realpathSync(path)).mode & 0o777;
}

/** Write via a sibling temp file + rename so a crash never leaves a truncated
 *  config. A symlinked dotfile is written through to its target (the link is
 *  kept); an existing file keeps its mode, and a new one is created 0600. */
export function writeFileAtomic(path: string, contents: string): void {
	const target = resolveLinkTarget(path);
	const mode = fileMode(target) ?? 0o600;
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	const temp = join(
		dir,
		`.${basename(target)}.ryu-${process.pid}-${Date.now()}.tmp`
	);
	try {
		writeFileSync(temp, contents, { mode });
		chmodSync(temp, mode);
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Delete a config file Ryu created and that now holds nothing else. */
export function deleteConfigFile(path: string): void {
	// Remove the file Ryu created, not a symlink the user keeps pointing at it.
	rmSync(resolveLinkTarget(path), { force: true });
}
