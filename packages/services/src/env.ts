// packages/services/src/env.ts
//
// Guarded environment reads. Edge runtimes and browsers have no `process`, and
// some sandboxes throw on access, so env is read through one function that
// never throws. `env: false` turns env reads off entirely; an object (Hono's
// `c.env`, a test fixture) replaces `process.env`.

/** Where configuration env vars come from. */
export type RyuEnvSource = Record<string, string | undefined> | false;

/** Reads one variable; empty and whitespace-only values count as unset. */
export type EnvReader = (name: string) => string | undefined;

function processEnv(): Record<string, string | undefined> {
	try {
		const processLike = (
			globalThis as {
				process?: { env?: Record<string, string | undefined> };
			}
		).process;
		return processLike?.env ?? {};
	} catch {
		return {};
	}
}

/**
 * A reader over `source`: `false` reads nothing, an object reads that object,
 * and `undefined` reads `globalThis.process.env` when it exists.
 */
export function createEnvReader(source: RyuEnvSource | undefined): EnvReader {
	if (source === false) {
		return () => undefined;
	}
	const values = source ?? processEnv();
	return (name) => {
		let value: string | undefined;
		try {
			value = values[name];
		} catch {
			return undefined;
		}
		if (typeof value !== "string") {
			return undefined;
		}
		const trimmed = value.trim();
		return trimmed === "" ? undefined : trimmed;
	};
}
