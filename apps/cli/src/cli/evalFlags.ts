// Flag parsing for `ryu-cli eval` / `ryu-cli redteam` (see evalCommands.ts). The
// commands read their own flags from `ctx.rawArgs`: the global parser ignores
// unknown `--flags` but would leave their VALUES behind as positional args, so
// every eval flag is consumed here instead.

import { localize } from "./localizedText.ts";
import { UsageError } from "./types.ts";

export const EVAL_USAGE =
	"ryu-cli eval [agent-id] [model] [--dataset <file>] [--scorer <id>]… [--threshold <n|scorer=n>]… [--json|--junit]";
export const REDTEAM_USAGE =
	"ryu-cli redteam <agent-id> [model] [--max-attention <n>] [--json|--junit]";

/** Global flags that take a value; skipped so their value is not positional. */
const GLOBAL_VALUE_FLAGS = new Set([
	"--file",
	"--kind",
	"--node",
	"--template",
	"-f",
]);
/** Global boolean flags that are not positional and carry no value. */
const IGNORED_SWITCHES = new Set([
	"--cascade",
	"--dry-run",
	"--fix",
	"--force",
	"--include-secrets",
]);

/** Flags parsed from one `ryu-cli eval` / `ryu-cli redteam` invocation. */
export interface EvalFlags {
	agent: string | null;
	concurrency: number | null;
	dataset: string | null;
	json: boolean;
	judgeModel: string | null;
	junit: boolean;
	maxAttention: number | null;
	model: string | null;
	positional: string[];
	scorers: string[];
	thresholds: string[];
}

type ValueFlag =
	| "agent"
	| "concurrency"
	| "dataset"
	| "judgeModel"
	| "maxAttention"
	| "model"
	| "scorer"
	| "threshold";

const EVAL_VALUE_FLAGS = new Map<string, ValueFlag>([
	["--agent", "agent"],
	["--concurrency", "concurrency"],
	["--dataset", "dataset"],
	["-d", "dataset"],
	["--judge-model", "judgeModel"],
	["--max-attention", "maxAttention"],
	["--model", "model"],
	["--scorer", "scorer"],
	["--scorers", "scorer"],
	["-s", "scorer"],
	["--threshold", "threshold"],
	["-t", "threshold"],
]);

function nonNegativeInteger(raw: string, flag: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new UsageError(
			localize("{flag} must be a non-negative integer", { flag })
		);
	}
	return value;
}

function applyValue(
	flags: EvalFlags,
	key: ValueFlag,
	name: string,
	value: string
): void {
	switch (key) {
		case "agent":
			flags.agent = value;
			break;
		case "concurrency": {
			const parsed = nonNegativeInteger(value, name);
			if (parsed === 0) {
				throw new UsageError(localize("{name} must be at least 1", { name }));
			}
			flags.concurrency = parsed;
			break;
		}
		case "dataset":
			flags.dataset = value;
			break;
		case "judgeModel":
			flags.judgeModel = value;
			break;
		case "maxAttention":
			flags.maxAttention = nonNegativeInteger(value, name);
			break;
		case "model":
			flags.model = value;
			break;
		case "scorer":
			flags.scorers.push(value);
			break;
		case "threshold":
			flags.thresholds.push(value);
			break;
		default:
			break;
	}
}

/** Parse the eval/redteam flags out of the raw tokens after the subcommand. */
export function parseEvalFlags(rawArgs: readonly string[]): EvalFlags {
	const flags: EvalFlags = {
		agent: null,
		concurrency: null,
		dataset: null,
		judgeModel: null,
		json: false,
		junit: false,
		maxAttention: null,
		model: null,
		positional: [],
		scorers: [],
		thresholds: [],
	};
	for (let index = 0; index < rawArgs.length; index += 1) {
		const token = rawArgs[index] ?? "";
		if (token === "--") {
			flags.positional.push(...rawArgs.slice(index + 1));
			break;
		}
		if (token === "--json") {
			flags.json = true;
			continue;
		}
		if (token === "--junit") {
			flags.junit = true;
			continue;
		}
		if (IGNORED_SWITCHES.has(token)) {
			continue;
		}
		const eq = token.startsWith("-") ? token.indexOf("=") : -1;
		const name = eq === -1 ? token : token.slice(0, eq);
		const key = EVAL_VALUE_FLAGS.get(name);
		if (key) {
			const value = eq === -1 ? rawArgs[index + 1] : token.slice(eq + 1);
			if (value === undefined || value === "") {
				throw new UsageError(
					localize("{name} needs a value. Usage: {usage}", {
						name,
						usage: EVAL_USAGE,
					})
				);
			}
			if (eq === -1) {
				index += 1;
			}
			applyValue(flags, key, name, value);
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(name)) {
			if (eq === -1) {
				index += 1;
			}
			continue;
		}
		if (token.startsWith("-")) {
			throw new UsageError(
				localize("Unknown flag {name}. Usage: {usage}", {
					name,
					usage: EVAL_USAGE,
				})
			);
		}
		flags.positional.push(token);
	}
	if (flags.json && flags.junit) {
		throw new UsageError("Use either --json or --junit, not both");
	}
	return flags;
}

/**
 * Remove the first positional `action` token (`ryu-cli observability eval …`) so the
 * delegated command sees the same tokens as `ryu-cli eval …`. Flag values are
 * skipped, so `--dataset eval` is never mistaken for the action.
 */
export function withoutActionToken(
	rawArgs: readonly string[],
	action: string
): string[] {
	for (let index = 0; index < rawArgs.length; index += 1) {
		const token = rawArgs[index] ?? "";
		if (token === "--") {
			break;
		}
		if (token.startsWith("-")) {
			const takesValue =
				!token.includes("=") &&
				(EVAL_VALUE_FLAGS.has(token) || GLOBAL_VALUE_FLAGS.has(token));
			if (takesValue) {
				index += 1;
			}
			continue;
		}
		if (token === action) {
			return [...rawArgs.slice(0, index), ...rawArgs.slice(index + 1)];
		}
		break;
	}
	return [...rawArgs];
}
