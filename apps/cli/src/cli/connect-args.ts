// `ryu-cli connect`'s own argv: the value flags it takes and the whole-number
// checks for `--limit` and `--max-cost`. Split from `connect.ts`.

import { UsageError } from "./types.ts";

export type ValueName =
	| "args"
	| "argsFile"
	| "catalogUrl"
	| "idempotencyKey"
	| "kind"
	| "limit"
	| "maxCost"
	| "query"
	| "toolkit"
	| "url";

export const VALUE_FLAGS = new Map<string, ValueName>([
	["--args", "args"],
	["--args-file", "argsFile"],
	["--catalog-url", "catalogUrl"],
	["--idempotency-key", "idempotencyKey"],
	["--kind", "kind"],
	["--limit", "limit"],
	["--max-cost", "maxCost"],
	["--query", "query"],
	["--toolkit", "toolkit"],
	["--url", "url"],
]);

export interface ConnectArgs {
	positional: string[];
	values: Partial<Record<ValueName, string>>;
}

/** Parse `ryu-cli connect`'s own argv (everything after `connect`). */
export function parseConnectArgs(argv: readonly string[]): ConnectArgs {
	const positional: string[] = [];
	const values: Partial<Record<ValueName, string>> = {};
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (token === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (token === "--json") {
			continue;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const name = eq === -1 ? token : token.slice(0, eq);
			const key = VALUE_FLAGS.get(name);
			if (!key) {
				throw new UsageError(
					`Unknown option '${name}' (see 'ryu-cli connect help').`
				);
			}
			const value = eq === -1 ? argv[index + 1] : token.slice(eq + 1);
			if (value === undefined || (eq === -1 && value.startsWith("--"))) {
				throw new UsageError(`${name} needs a value.`);
			}
			if (eq === -1) {
				index++;
			}
			values[key] = value;
			continue;
		}
		positional.push(token);
	}
	return { positional, values };
}

/** A whole-number flag value within `[min, max]`; absent stays undefined. */
export function integer(
	value: string | undefined,
	name: string,
	min: number,
	max: number
): number | undefined {
	if (value === undefined) {
		return;
	}
	if (
		!/^\d{1,15}$/u.test(value) ||
		Number(value) < min ||
		Number(value) > max
	) {
		throw new UsageError(
			`${name} must be a whole number from ${min} to ${max}.`
		);
	}
	return Number(value);
}
