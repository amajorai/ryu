// packages/services-cli/src/args.ts
//
// A small, dependency-free argv parser for `ryu-services`. Flags are declared
// as specs (type and description), so the same table drives parsing, help
// text and the registry tests. Supported forms: `--flag value`,
// `--flag=value`, boolean `--flag`, repeated `--flag a --flag b` for list
// flags, the `-h` short form of `--help`, and `--` to pass everything after it
// through untouched (`box exec <id> -- ls -la`).

/** How a flag's value is read. `strings` collects every occurrence into a list. */
export type FlagType = "boolean" | "string" | "number" | "strings";

/** One declared flag. */
export interface FlagSpec {
	readonly description: string;
	/**
	 * True when the command refuses to run without this flag. Help prints
	 * `(required)` after the description; the command still checks it (for
	 * example with {@link requireStringFlag}).
	 */
	readonly required?: boolean;
	/** A one-letter alias, written `-x`. */
	readonly short?: string;
	readonly type: FlagType;
	/** Shown in help after the flag name, e.g. `--title <text>`. */
	readonly valueName?: string;
}

/** Flags keyed by their long name without the leading dashes. */
export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

/** A parsed flag value. */
export type FlagValue = boolean | string | number | readonly string[];

/** Parsed flags keyed by long name. Absent flags are missing, never `undefined`. */
export type ParsedFlags = Readonly<Record<string, FlagValue>>;

/** The result of {@link parseTokens}. */
export interface ParsedArgs {
	readonly flags: ParsedFlags;
	/** Positional arguments before any `--`. */
	readonly positionals: readonly string[];
	/** Everything after a bare `--`, or an empty list. */
	readonly rest: readonly string[];
}

/** A command line that cannot be run as written. The CLI exits with code 2. */
export class CliUsageError extends Error {
	/** What to run next; the CLI prints `Run ryu-services --help for usage.` when unset. */
	readonly hint: string | undefined;

	constructor(message: string, options: { hint?: string } = {}) {
		super(message);
		this.name = "CliUsageError";
		this.hint = options.hint;
	}
}

/** Flags every `ryu-services` command accepts (design §10). */
export const GLOBAL_FLAGS = {
	json: {
		type: "boolean",
		description: "Print machine-readable JSON: { data, meta } or { error }.",
	},
	"dry-run": {
		type: "boolean",
		description:
			"Print the equivalent curl command instead of sending the request. The key is shown as its env placeholder. Only the first request of a multi-step command or stream is printed.",
	},
	"base-url": {
		type: "string",
		valueName: "url",
		description: "Override the service base URL.",
	},
	"api-key": {
		type: "string",
		valueName: "key",
		description:
			"Override the service key. Prefer the env var: flags can end up in shell history.",
	},
	"idempotency-key": {
		type: "string",
		valueName: "key",
		description: "Idempotency-Key for the first idempotent write of the call.",
	},
	timeout: {
		type: "number",
		valueName: "ms",
		description: "Per-attempt timeout until response headers, in ms.",
	},
	"max-retries": {
		type: "number",
		valueName: "n",
		description: "Retries after the first attempt (default 2).",
	},
	help: { type: "boolean", short: "h", description: "Show help." },
} as const satisfies FlagSpecs;

const FLAG_NAME = /^[a-z][a-z0-9-]*$/u;

function findSpec(
	specs: FlagSpecs,
	token: string
): { name: string; spec: FlagSpec; inline: string | null } | null {
	if (token.startsWith("--")) {
		const body = token.slice(2);
		const equals = body.indexOf("=");
		const name = equals === -1 ? body : body.slice(0, equals);
		const inline = equals === -1 ? null : body.slice(equals + 1);
		const spec = specs[name];
		return spec ? { name, spec, inline } : null;
	}
	const short = token.slice(1);
	for (const [name, spec] of Object.entries(specs)) {
		if (spec.short !== undefined && spec.short === short) {
			return { name, spec, inline: null };
		}
	}
	return null;
}

function isFlagToken(token: string): boolean {
	return token.length > 1 && token.startsWith("-") && token !== "--";
}

function numberValue(name: string, raw: string): number {
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(value)) {
		throw new CliUsageError(
			`--${name} expects a number, got ${JSON.stringify(raw)}.`
		);
	}
	return value;
}

/**
 * Parses `argv` against `specs`. Unknown flags, missing values and bad
 * numbers raise {@link CliUsageError}. A boolean flag takes no value
 * (`--json=false` is rejected rather than silently read as true).
 */
export function parseTokens(
	argv: readonly string[],
	specs: FlagSpecs
): ParsedArgs {
	const flags: Record<string, FlagValue> = {};
	const positionals: string[] = [];
	let rest: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") {
			rest = argv.slice(index + 1);
			break;
		}
		if (!isFlagToken(token)) {
			positionals.push(token);
			continue;
		}
		const match = findSpec(specs, token);
		if (match === null) {
			throw new CliUsageError(`Unknown flag ${token.split("=")[0]}.`);
		}
		const { name, spec, inline } = match;
		if (spec.type === "boolean") {
			if (inline !== null) {
				throw new CliUsageError(`--${name} does not take a value.`);
			}
			flags[name] = true;
			continue;
		}
		let raw = inline;
		if (raw === null) {
			const next = argv[index + 1];
			if (next === undefined || next === "--") {
				throw new CliUsageError(`--${name} needs a value.`);
			}
			raw = next;
			index += 1;
		}
		if (spec.type === "number") {
			flags[name] = numberValue(name, raw);
		} else if (spec.type === "strings") {
			const previous = flags[name];
			flags[name] = [...(Array.isArray(previous) ? previous : []), raw];
		} else {
			flags[name] = raw;
		}
	}
	return { flags, positionals, rest };
}

/**
 * The first positional token and its index, skipping flags (and the values
 * of value-taking flags in `specs`). Used to route before the full command
 * spec is known. Returns null when there is none.
 */
export function firstPositional(
	argv: readonly string[],
	specs: FlagSpecs
): { index: number; value: string } | null {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") {
			return null;
		}
		if (!isFlagToken(token)) {
			return { index, value: token };
		}
		const match = findSpec(specs, token);
		if (match && match.spec.type !== "boolean" && match.inline === null) {
			index += 1;
		}
	}
	return null;
}

/**
 * Merges flag tables. A name declared twice must have the same type, so one
 * spelling never parses two ways.
 */
export function mergeFlagSpecs(...tables: readonly FlagSpecs[]): FlagSpecs {
	const merged: Record<string, FlagSpec> = {};
	for (const table of tables) {
		for (const [name, spec] of Object.entries(table)) {
			if (!FLAG_NAME.test(name)) {
				throw new Error(`Invalid flag name ${JSON.stringify(name)}.`);
			}
			const existing = merged[name];
			if (existing && existing.type !== spec.type) {
				throw new Error(
					`Flag --${name} is declared as both ${existing.type} and ${spec.type}.`
				);
			}
			merged[name] ??= spec;
		}
	}
	return merged;
}

/** Rejects flags that were parsed but are not in `allowed` (for example another command's flag). */
export function assertKnownFlags(
	flags: ParsedFlags,
	allowed: FlagSpecs,
	commandName: string
): void {
	for (const name of Object.keys(flags)) {
		if (!Object.hasOwn(allowed, name)) {
			throw new CliUsageError(`${commandName} does not take --${name}.`);
		}
	}
}

/** A string flag, or undefined. */
export function stringFlag(
	flags: ParsedFlags,
	name: string
): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

/** A string flag that must be present. */
export function requireStringFlag(flags: ParsedFlags, name: string): string {
	const value = stringFlag(flags, name);
	if (value === undefined || value === "") {
		throw new CliUsageError(`--${name} is required.`);
	}
	return value;
}

/** A number flag, or undefined. */
export function numberFlag(
	flags: ParsedFlags,
	name: string
): number | undefined {
	const value = flags[name];
	return typeof value === "number" ? value : undefined;
}

/** True when a boolean flag was given. */
export function booleanFlag(flags: ParsedFlags, name: string): boolean {
	return flags[name] === true;
}

/** Every value of a list flag (empty when absent). */
export function stringsFlag(
	flags: ParsedFlags,
	name: string
): readonly string[] {
	const value = flags[name];
	return Array.isArray(value) ? value : [];
}

/** A non-negative integer flag (timeouts, retry counts), or undefined. */
export function countFlag(
	flags: ParsedFlags,
	name: string
): number | undefined {
	const value = numberFlag(flags, name);
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || value < 0) {
		throw new CliUsageError(`--${name} must be a non-negative integer.`);
	}
	return value;
}
