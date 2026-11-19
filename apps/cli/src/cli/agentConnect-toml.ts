// Codex's TOML config: the `[mcp_servers.ryu]` table spliced as text and
// verified by a re-parse. Split from `agentConnect.ts`.

import {
	inlineNotRemovable,
	inlineNotReplaceable,
	invalidToml,
	notTomlTable,
	serversAtRoot,
	sideEffectLayout,
} from "./agentConnect-errors.ts";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	MCP_SERVER_NAME,
	sameEntry,
} from "./agentConnect-types.ts";

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

export function parseToml(text: string | null, label: string): JsonObject {
	if (text === null || text.trim() === "") {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch (error) {
		throw invalidToml(label, String(error));
	}
	if (!isJsonObject(parsed)) {
		throw notTomlTable(label);
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

export function tomlRyuEntry(doc: JsonObject): JsonValue | undefined {
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

export function setTomlEntry(
	original: string | null,
	entry: JsonObject,
	label: string
): string {
	const before = parseToml(original, label);
	if (definesServersAtRoot(original ?? "")) {
		throw serversAtRoot(label, MCP_SERVER_NAME);
	}
	const block = renderTomlEntry(entry).split("\n");
	const split = splitOutRyuTables(original ?? "");
	if (tomlRyuEntry(before) !== undefined && !split.removedAny) {
		throw inlineNotReplaceable(label, MCP_SERVER_NAME);
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
		throw sideEffectLayout(label);
	}
	return result;
}

export function removeTomlEntry(original: string, label: string): string {
	const before = parseToml(original, label);
	const split = splitOutRyuTables(original);
	if (!split.removedAny) {
		if (tomlRyuEntry(before) !== undefined) {
			throw inlineNotRemovable(label, MCP_SERVER_NAME);
		}
		return original;
	}
	const result = joinToml(split.kept, split.eol);
	const after = parseToml(result, label);
	if (
		tomlRyuEntry(after) !== undefined ||
		!sameEntry(withoutTomlRyu(after), withoutTomlRyu(before))
	) {
		throw sideEffectLayout(label);
	}
	return result;
}
