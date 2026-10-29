// packages/services/src/tools/run.ts
//
// How a registry tool runs, shared by every adapter: parse the input with the
// tool's zod schema (a failure is a RyuInvalidRequestError, code
// `invalid_arguments`, with the issues in `details`), run the body, and settle
// the outcome into a RyuResult. Nothing here throws: an adapter decides how
// to hand a failure to its host (MCP `isError`, an `{ error }` tool result).
//
// `toToolResultJson` is the model-facing projection the adapters return: the
// error keeps only what a model acts on (code, message, hint, retryable,
// status, details, requestId) and the meta only the request id, the
// idempotency key and a replay, each only when set. SDK callers of
// `runRyuTool` still get the full RyuResult.

import type * as z from "zod";
import type { RyuError } from "../errors.ts";
import type { RyuResponseMeta, RyuResult } from "../result.ts";
import type { Ryu } from "../ryu.ts";
import {
	messageWithoutHint,
	RyuConfigurationError,
	RyuInvalidRequestError,
	toResult,
	toRyuError,
} from "./core.ts";
import type { AnyRyuTool, RyuToolContext } from "./types.ts";

const SETTLED = Symbol.for("@ryuhq/services.tools.settled");

/** A facade call already settled into its result and meta. See {@link settled}. */
export interface SettledToolCall {
	readonly [SETTLED]: RyuResult<unknown>;
}

/**
 * In an async tool body: settles a facade call together with its meta, so
 * the tool result reports the request id and idempotency key
 * (`return settled(ryu.sites.projects.list())`). A RyuError is rethrown, as
 * the call itself would.
 */
export async function settled(
	call: PromiseLike<unknown>
): Promise<SettledToolCall> {
	const result = await toResult(call);
	if (result.error !== null) {
		throw result.error;
	}
	return { [SETTLED]: result };
}

/**
 * Like {@link settled}, but hands the tool `map(data)` and keeps the call's
 * meta: `settledMap(ryu.box.files.readText(id, path), (text) => ...)`.
 */
export async function settledMap<T>(
	call: PromiseLike<T>,
	map: (data: T) => unknown
): Promise<SettledToolCall> {
	const result = await toResult(call);
	if (result.error !== null) {
		throw result.error;
	}
	return { [SETTLED]: { ...result, data: map(result.data as T) } };
}

/** True when `value` came from {@link settled}. */
export function isSettledToolCall(value: unknown): value is SettledToolCall {
	return typeof value === "object" && value !== null && SETTLED in value;
}

/**
 * Runs a tool body (already given parsed input) and settles it. The body's
 * return value may be a facade promise (its meta is kept), a
 * {@link settled} call, or plain data. Anything thrown becomes a RyuError for
 * `service`.
 */
export async function settleToolCall(
	service: AnyRyuTool["service"],
	call: () => unknown
): Promise<RyuResult<unknown>> {
	try {
		const outcome = await toResult(Promise.resolve(call()));
		if (outcome.error === null && isSettledToolCall(outcome.data)) {
			return outcome.data[SETTLED];
		}
		return outcome;
	} catch (error) {
		return { data: null, error: toRyuError(error, service), meta: null };
	}
}

/** One zod issue as a tool error reports it. */
export interface RyuToolInputIssue {
	readonly code: string;
	readonly message: string;
	/** The argument path, e.g. `to.0` or `idempotencyKey`; empty for the whole input. */
	readonly path: string;
}

function issueList(error: z.ZodError): RyuToolInputIssue[] {
	return error.issues.map((issue) => ({
		code: issue.code,
		message: issue.message,
		path: issue.path.map(String).join("."),
	}));
}

/** The RyuError a tool call with arguments its schema rejects answers with. */
export function invalidToolInput(
	tool: Pick<AnyRyuTool, "name" | "service">,
	error: z.ZodError
): RyuInvalidRequestError {
	const issues = issueList(error);
	const summary = issues
		.map((issue) =>
			issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`
		)
		.join("; ");
	return new RyuInvalidRequestError({
		service: tool.service,
		status: 0,
		code: "invalid_arguments",
		message: `${tool.name} was called with invalid arguments: ${summary}`,
		hint: "Fix the arguments named in details.issues and call the tool again.",
		details: { tool: tool.name, issues },
		retryable: false,
	});
}

/** Parses `input` with the tool's schema. */
export function parseToolInput(
	tool: AnyRyuTool,
	input: unknown
):
	| { readonly ok: true; readonly value: z.output<AnyRyuTool["inputSchema"]> }
	| { readonly ok: false; readonly error: RyuInvalidRequestError } {
	const parsed = tool.inputSchema.safeParse(input ?? {});
	return parsed.success
		? { ok: true, value: parsed.data }
		: { ok: false, error: invalidToolInput(tool, parsed.error) };
}

/** The facade namespaces a tool body can reach through `ryu`. */
const NAMESPACE_KEYS: ReadonlySet<string> = new Set([
	"managedAgents",
	"messaging",
	"mail",
	"notify",
	"box",
	"gateway",
	"connect",
	"passport",
	"sites",
]);

/**
 * `ryu` as a tool body should see it for one call: when the host passed an
 * abort signal, every namespace is bound with `.with({ signal })`, so
 * cancelling the tool call aborts whatever request the body is waiting on
 * (`box_exec`, a Gateway chat, a Managed Agents stream). A body's own
 * `.with({ idempotencyKey })` keeps the signal. Without a signal, `ryu` itself.
 */
export function ryuForToolCall(ryu: Ryu, context: RyuToolContext = {}): Ryu {
	const { signal } = context;
	if (signal === undefined) {
		return ryu;
	}
	return new Proxy(ryu, {
		get(target, key) {
			// The facade keeps its state in private fields: read with the
			// target as receiver, and bind methods to it.
			const value: unknown = Reflect.get(target, key, target);
			if (typeof key === "string" && NAMESPACE_KEYS.has(key)) {
				return (
					value as { with(options: { signal: AbortSignal }): unknown }
				).with({ signal });
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Validates `input` and runs `tool` against `ryu`. Resolves to the SDK's
 * `{ data, error, meta }` result; never rejects.
 */
export async function runRyuTool(
	ryu: Ryu,
	tool: AnyRyuTool,
	input: unknown,
	context: RyuToolContext = {}
): Promise<RyuResult<unknown>> {
	if (ryu.resultMode !== "throw") {
		// An object-mode client resolves failures as data, which would turn a
		// 401 into a successful tool result.
		const error = new RyuConfigurationError({
			service: tool.service,
			status: 0,
			message: `${tool.name} needs a Ryu client in the default result mode; this one was built with result: "object".`,
		});
		return { data: null, error, meta: null };
	}
	const parsed = parseToolInput(tool, input);
	if (!parsed.ok) {
		return { data: null, error: parsed.error, meta: null };
	}
	return settleToolCall(tool.service, () =>
		tool.run(ryuForToolCall(ryu, context), parsed.value, context)
	);
}

/** A tool error as a model sees it: the fields it can act on, null ones dropped. */
export interface RyuToolErrorJSON {
	readonly code: string;
	readonly details?: unknown;
	readonly hint?: string;
	readonly message: string;
	readonly requestId?: string;
	/** Seconds to wait before retrying, when the service said. */
	readonly retryAfterSeconds?: number;
	readonly retryable: boolean;
	readonly service: string;
	/** The HTTP status; 0 when no response arrived (bad arguments, timeout, abort). */
	readonly status: number;
}

/** A tool result's meta as a model sees it: each field only when set. */
export interface RyuToolMetaJSON {
	readonly idempotencyKey?: string;
	/** The server answered from an earlier call with the same idempotency key. */
	readonly replayed?: true;
	readonly requestId?: string;
}

/** A tool result as compact plain JSON: `{ data, error, meta }`. */
export type RyuToolResultJSON =
	| {
			readonly data: unknown;
			readonly error: null;
			readonly meta: RyuToolMetaJSON;
	  }
	| {
			readonly data: null;
			readonly error: RyuToolErrorJSON;
			readonly meta: RyuToolMetaJSON;
	  };

function jsonReplacer(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

/** Round-trips `value` through JSON, so a result holds no Dates, bigints or class instances. */
export function toPlainJson(value: unknown): unknown {
	const text = JSON.stringify(value, jsonReplacer);
	return text === undefined ? null : (JSON.parse(text) as unknown);
}

/** The meta fields a model can use, each only when set. */
export function toToolMetaJson(
	meta: RyuResponseMeta | null | undefined
): RyuToolMetaJSON {
	return {
		...(meta?.requestId ? { requestId: meta.requestId } : {}),
		...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
		...(meta?.replayed === true ? { replayed: true as const } : {}),
	};
}

/**
 * The error fields a model can act on; never keys, headers or URLs. The hint
 * has its own field, so `message` is the error's message without it.
 */
export function toToolErrorJson(error: RyuError): RyuToolErrorJSON {
	return {
		code: error.code,
		message: messageWithoutHint(error),
		service: error.service,
		status: error.status,
		retryable: error.retryable,
		...(error.hint ? { hint: error.hint } : {}),
		...(error.details === null || error.details === undefined
			? {}
			: { details: toPlainJson(error.details) }),
		...(error.requestId ? { requestId: error.requestId } : {}),
		...(typeof error.retryAfterSeconds === "number"
			? { retryAfterSeconds: error.retryAfterSeconds }
			: {}),
	};
}

/** Projects a tool's RyuResult for a model. See the module comment. */
export function toToolResultJson(
	result: RyuResult<unknown>
): RyuToolResultJSON {
	if (result.error === null) {
		return {
			data: toPlainJson(result.data ?? null),
			error: null,
			meta: toToolMetaJson(result.meta),
		};
	}
	return {
		data: null,
		error: toToolErrorJson(result.error),
		meta: toToolMetaJson(result.meta),
	};
}
