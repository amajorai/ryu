// packages/services-cli/src/settled.ts
//
// `settled(call)`: lets an async command or tool body hand a facade call back
// together with its response meta. `toResult` finds a call's meta only on the
// facade promise itself, so a body that awaits something first (reads a
// file, waits for a Box) would otherwise print `meta` as the empty
// placeholder. The CLI's printOutcome and the MCP runTool unwrap it.

import {
	type RyuResponseMeta,
	type RyuResult,
	toResult,
} from "@ryuhq/services";

const SETTLED = Symbol("ryu-services.settled");

/** A facade call already settled into its result and meta. See {@link settled}. */
export interface SettledCall {
	readonly [SETTLED]: RyuResult<unknown>;
}

/**
 * In an async command or tool body: settles a facade call with its meta, so
 * `--json` and MCP results report it (`return settled(ctx.ryu.sites.deploy(…))`).
 * A RyuError is rethrown, as the call itself would.
 */
export async function settled(
	call: PromiseLike<unknown>
): Promise<SettledCall> {
	const result = await toResult(call);
	if (result.error !== null) {
		throw result.error;
	}
	return { [SETTLED]: result };
}

/**
 * Pairs `data` with the meta of an earlier call: `box create --wait` prints
 * the ready Box with the create's request id and idempotency key.
 */
export function settledWith(data: unknown, meta: RyuResponseMeta): SettledCall {
	return { [SETTLED]: { data, error: null, meta } };
}

function isSettledCall(value: unknown): value is SettledCall {
	return typeof value === "object" && value !== null && SETTLED in value;
}

/** The settled call inside `result`, or `result` itself. */
export function unwrapSettled(result: RyuResult<unknown>): RyuResult<unknown> {
	return result.error === null && isSettledCall(result.data)
		? result.data[SETTLED]
		: result;
}

/** The data of a settled call, or `value` itself when it is not one. */
export function settledData(value: unknown): unknown {
	return isSettledCall(value) ? value[SETTLED].data : value;
}
