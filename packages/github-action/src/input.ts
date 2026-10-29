import {
	parseEvalThresholds,
	parseScorerList,
} from "@ryuhq/core-client/eval-gate";
import { z } from "zod";
import { assertSecureNodeUrl } from "./client.ts";
import {
	type JsonRecord,
	JsonRecordSchema,
	type JsonValue,
	JsonValueSchema,
} from "./json.ts";
import type {
	ActionInputs,
	Operation,
	ResolvedTarget,
	TargetMode,
	VaultSecretRef,
} from "./types.ts";

export interface InputReader {
	get(name: string): string;
}

const TARGETS = new Set<TargetMode>(["auto", "self-hosted", "managed"]);
const OPERATIONS = new Set<Operation>(["setup", "run", "tool", "eval"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function clean(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}

function booleanInput(
	reader: InputReader,
	name: string,
	fallback: boolean
): boolean {
	const value = clean(reader.get(name));
	if (value === null) {
		return fallback;
	}
	if (value === "true" || value === "1" || value === "yes") {
		return true;
	}
	if (value === "false" || value === "0" || value === "no") {
		return false;
	}
	throw new Error(`Input '${name}' must be true or false.`);
}

/** Split a comma/newline-separated input into trimmed, non-empty entries. */
function listInput(reader: InputReader, name: string): string[] {
	return (reader.get(name) ?? "")
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

function jsonInput(reader: InputReader, name: string): JsonValue {
	const value = clean(reader.get(name));
	if (value === null) {
		return null;
	}
	try {
		return JsonValueSchema.parse(JSON.parse(value));
	} catch (error) {
		throw new Error(
			`Input '${name}' must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function recordInput(reader: InputReader, name: string): JsonRecord | null {
	const value = jsonInput(reader, name);
	if (value === null) {
		return null;
	}
	const parsed = JsonRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`Input '${name}' must contain a JSON object.`);
	}
	return parsed.data;
}

function booleanRecordInput(
	reader: InputReader,
	name: string
): Record<string, boolean> | null {
	const record = recordInput(reader, name);
	if (record === null) {
		return null;
	}
	for (const [key, value] of Object.entries(record)) {
		if (!z.boolean().safeParse(value).success) {
			throw new Error(`Input '${name}' field '${key}' must be a boolean.`);
		}
	}
	return z.record(z.string(), z.boolean()).parse(record);
}

function positiveIntegerInput(
	reader: InputReader,
	name: string,
	fallback: number
): number {
	const value = clean(reader.get(name));
	if (value === null) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Input '${name}' must be a positive integer.`);
	}
	return parsed;
}

function enumInput<T extends string>(
	reader: InputReader,
	name: string,
	allowed: ReadonlySet<T>,
	fallback: T
): T {
	const value = clean(reader.get(name)) ?? fallback;
	const matched = [...allowed].find((option) => option === value);
	if (matched === undefined) {
		throw new Error(
			`Input '${name}' must be one of: ${Array.from(allowed).join(", ")}.`
		);
	}
	return matched;
}

const ENV_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FOLDER_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FOLDER_DEPTH = 8;

/** Parse one vault reference with Core's grammar (`secret:` prefix optional). */
export function parseVaultSecretRef(line: string): VaultSecretRef | null {
	const reference = line.trim();
	let rest = reference.startsWith("secret:")
		? reference.slice("secret:".length)
		: reference;
	let environment: string | null = null;
	const colon = rest.indexOf(":");
	if (colon !== -1) {
		environment = rest.slice(0, colon);
		rest = rest.slice(colon + 1);
		if (!ENV_SLUG.test(environment)) {
			return null;
		}
	}
	let path = "/";
	if (rest.startsWith("/")) {
		const segments = rest.split("/").slice(1);
		rest = segments.pop() ?? "";
		if (
			segments.length > MAX_FOLDER_DEPTH ||
			!segments.every((segment) => FOLDER_SEGMENT.test(segment))
		) {
			return null;
		}
		path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
	}
	if (!SECRET_NAME.test(rest)) {
		return null;
	}
	return { environment, name: rest, path, reference };
}

/** Parse the newline-separated `secrets` input. Blank lines and `#` comments
 *  are ignored; two lines exporting the same variable name are rejected. */
export function parseSecretsInput(value: string | undefined): VaultSecretRef[] {
	const refs: VaultSecretRef[] = [];
	const seen = new Set<string>();
	for (const raw of (value ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const ref = parseVaultSecretRef(line);
		if (!ref) {
			throw new Error(
				`Input 'secrets' has an invalid reference '${line}'. Use NAME or ENV:/folder/NAME.`
			);
		}
		if (seen.has(ref.name)) {
			throw new Error(
				`Input 'secrets' lists '${ref.name}' more than once; each exports one environment variable.`
			);
		}
		seen.add(ref.name);
		refs.push(ref);
	}
	return refs;
}

export function parseActionInputs(reader: InputReader): ActionInputs {
	const operation = enumInput(reader, "operation", OPERATIONS, "setup");
	const target = enumInput(reader, "target", TARGETS, "auto");
	const toolArguments = jsonInput(reader, "tool-arguments") ?? {};

	return {
		agent: clean(reader.get("agent")),
		conversationId: clean(reader.get("conversation-id")),
		cwd: clean(reader.get("cwd")),
		enableLongTerm: booleanInput(reader, "enable-long-term", false),
		evalDataset: clean(reader.get("eval-dataset")),
		evalJudgeModel: clean(reader.get("eval-judge-model")),
		evalJunitFile: clean(reader.get("eval-junit-file")),
		evalModel: clean(reader.get("eval-model")),
		evalScorers: parseScorerList([reader.get("eval-scorers") ?? ""]),
		evalThresholds: listInput(reader, "eval-threshold"),
		exportEnv: booleanInput(reader, "export-env", true),
		inference: recordInput(reader, "inference"),
		managedNodeToken: clean(reader.get("managed-node-token")),
		managedNodeUrl: clean(reader.get("managed-node-url")),
		nodeToken: clean(reader.get("node-token")),
		nodeUrl: clean(reader.get("node-url")),
		operation,
		persist: booleanInput(reader, "persist", false),
		pluginFlags: booleanRecordInput(reader, "plugin-flags"),
		prompt: clean(reader.get("prompt")),
		responseFile: clean(reader.get("response-file")),
		secrets: parseSecretsInput(reader.get("secrets")),
		target,
		team: clean(reader.get("team")),
		timeoutMs: positiveIntegerInput(reader, "timeout-ms", DEFAULT_TIMEOUT_MS),
		tool: clean(reader.get("tool")),
		toolArguments,
		userId: clean(reader.get("user-id")),
		vaultJwtAudience: clean(reader.get("vault-jwt-audience")),
		vaultJwtIdentity: clean(reader.get("vault-jwt-identity")),
		vaultRoleId: clean(reader.get("vault-role-id")),
		vaultSecretId: clean(reader.get("vault-secret-id")),
		workflow: clean(reader.get("workflow")),
		worktreeIsolation: booleanInput(reader, "worktree-isolation", false),
		writeSummary: booleanInput(reader, "write-summary", true),
	};
}

function pick(...values: Array<string | null | undefined>): string | null {
	for (const value of values) {
		const selected = clean(value ?? undefined);
		if (selected !== null) {
			return selected;
		}
	}
	return null;
}

export function normalizeNodeUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Ryu node URL is invalid: '${value}'.`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Ryu node URL must use http or https.");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error(
			"Ryu node URL must not include credentials, query parameters, or a fragment."
		);
	}
	// The node token and vault login credentials never cross cleartext
	// transport: plain http only reaches a node on the runner itself.
	assertSecureNodeUrl(parsed.href);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host}${pathname}`;
}

interface TargetCandidate {
	token: string | null;
	url: string | null;
}

export function resolveTarget(
	inputs: Pick<
		ActionInputs,
		"managedNodeToken" | "managedNodeUrl" | "nodeToken" | "nodeUrl" | "target"
	>,
	environment: Record<string, string | undefined> = process.env
): ResolvedTarget {
	const managed = {
		token: pick(inputs.managedNodeToken, environment.RYU_MANAGED_NODE_TOKEN),
		url: pick(inputs.managedNodeUrl, environment.RYU_MANAGED_NODE_URL),
	};
	const selfHosted = {
		token: pick(inputs.nodeToken, environment.RYU_CORE_TOKEN),
		url: pick(inputs.nodeUrl, environment.RYU_CORE_URL),
	};
	let selected: TargetCandidate;
	if (inputs.target === "managed") {
		selected = managed;
	} else if (inputs.target === "self-hosted") {
		selected = selfHosted;
	} else if (inputs.nodeUrl !== null) {
		selected = selfHosted;
	} else if (inputs.managedNodeUrl !== null) {
		selected = managed;
	} else if (environment.RYU_CORE_URL) {
		selected = selfHosted;
	} else {
		selected = managed;
	}

	if (selected.url === null) {
		throw new Error(
			"No Ryu node URL was provided. Set the node-url input or RYU_CORE_URL."
		);
	}

	return {
		mode: inputs.target,
		token: selected.token,
		url: normalizeNodeUrl(selected.url),
	};
}

function validateVaultInputs(inputs: ActionInputs): void {
	const appRole = inputs.vaultRoleId !== null || inputs.vaultSecretId !== null;
	if (appRole && !(inputs.vaultRoleId && inputs.vaultSecretId)) {
		throw new Error(
			"Inputs 'vault-role-id' and 'vault-secret-id' must be set together."
		);
	}
	if (appRole && inputs.vaultJwtIdentity) {
		throw new Error(
			"Use either 'vault-role-id'/'vault-secret-id' or 'vault-jwt-identity', not both."
		);
	}
	if (inputs.secrets.length > 0 && !(appRole || inputs.vaultJwtIdentity)) {
		throw new Error(
			"Input 'secrets' needs 'vault-role-id' and 'vault-secret-id', or 'vault-jwt-identity'."
		);
	}
}

export function validateOperationInputs(inputs: ActionInputs): void {
	validateVaultInputs(inputs);
	if (inputs.operation === "run") {
		if (!inputs.prompt) {
			throw new Error("Input 'prompt' is required when operation is 'run'.");
		}
		const selectors = [inputs.agent, inputs.team, inputs.workflow].filter(
			(value): value is string => value !== null
		);
		if (selectors.length > 1) {
			throw new Error(
				"Inputs 'agent', 'team', and 'workflow' are mutually exclusive for a run."
			);
		}
	}
	if (inputs.operation === "eval") {
		try {
			parseEvalThresholds(inputs.evalThresholds);
		} catch (error) {
			throw new Error(
				`Input 'eval-threshold' is invalid: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	if (inputs.operation === "tool") {
		if (!inputs.tool) {
			throw new Error("Input 'tool' is required when operation is 'tool'.");
		}
		if (!inputs.agent) {
			throw new Error(
				"Input 'agent' is required when operation is 'tool' because Core gates tool calls by agent allowlist."
			);
		}
	}
}
