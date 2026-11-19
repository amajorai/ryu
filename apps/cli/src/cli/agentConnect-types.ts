// The shared shapes of `agentConnect.ts` (entry specs, agent targets, JSON
// values) and key-order-independent entry comparison. Split from
// `agentConnect.ts`, which re-exports everything here.

import { createHash } from "node:crypto";

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
export type Env = Readonly<Record<string, string | undefined>>;

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

// ── Canonical comparison ───────────────────────────────────────────────────────

export function isJsonObject(value: unknown): value is JsonObject {
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
