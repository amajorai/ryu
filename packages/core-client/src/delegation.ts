// apps/desktop/src/lib/api/delegation.ts
//
// Typed client for Core's sub-agent delegation streaming endpoint
// (`POST /api/delegate/stream`). A parent hands one or more self-contained
// tasks to sub-agents that run concurrently (bounded by caps) with a clean
// context under a named permission preset. The endpoint streams SSE progress:
//   - `started`  : a delegate was admitted past the concurrency gate
//   - `finished` : a delegate completed (success or failure in `result`)
//   - `done`     : terminal — the ordered result array for the whole fan-out
//   - `error`    : terminal — validation/transport failure before/while running
//
// Per the Core-vs-Gateway rule this is a Core feature (it decides *what runs*).
// This module owns the request shape, SSE parsing, and event typing so the page
// stays declarative. Base URL + bearer always come from the node store via the
// shared client helpers.

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** The closed set of permission presets Core advertises to a delegate. */
export type PermissionPreset =
	| "research"
	| "code_read"
	| "code_write"
	| "summarise";

/** Human labels + descriptions for the preset picker, in display order. */
export const PRESET_OPTIONS: {
	value: PermissionPreset;
	label: string;
	hint: string;
}[] = [
	{
		value: "research",
		label: "Research",
		hint: "Read-only web/research tools, no filesystem or code mutation.",
	},
	{
		value: "code_read",
		label: "Code (read)",
		hint: "Read source files and metadata; no writes, no shell side effects.",
	},
	{
		value: "code_write",
		label: "Code (write)",
		hint: "Read and write source files; may run code-mutating tools.",
	},
	{
		value: "summarise",
		label: "Summarise",
		hint: "Pure text reduction; no tools at all.",
	},
];

/** A single delegation request: a self-contained task for one sub-agent. */
export interface DelegateSpec {
	/** Optional agent id to route to (defaults to the plain LLM backend). */
	agent_id?: string | null;
	/** Stable id within the fan-out (echoed in progress events). */
	id: string;
	/** Permission preset governing the delegate's capabilities. */
	preset: PermissionPreset;
	/** The self-contained task prompt (the delegate's ONLY context). */
	task: string;
}

/** Caps applied to a fan-out. Concurrency is clamped server-side to its max. */
export interface DelegationCaps {
	/** Max concurrent delegates (server clamps to the hard maximum). */
	max_concurrent: number;
	/** Per-delegate token budget. */
	max_tokens: number;
	/** Per-delegate wall-time limit in seconds. */
	wall_time_secs: number;
}

/** Hard limits the server enforces; surfaced so the UI can hint/clamp inputs. */
export const DELEGATION_LIMITS = {
	/** Maximum nesting depth Core will accept. */
	maxDepth: 3,
	/** Maximum concurrent sibling delegates per fan-out. */
	maxConcurrent: 5,
} as const;

export const DEFAULT_CAPS: DelegationCaps = {
	max_tokens: 4096,
	wall_time_secs: 120,
	max_concurrent: DELEGATION_LIMITS.maxConcurrent,
};

/** Outcome of a single delegate (carried in `finished` and `done`). */
export interface DelegateResult {
	/** Error message, when the delegate failed (including cap violations). */
	error: string | null;
	id: string;
	/** Final text produced by the sub-agent, when it completed. */
	output: string | null;
	preset: PermissionPreset;
}

/** A streamed delegation event, discriminated by `event`. */
export type DelegateEvent =
	| { event: "started"; id: string; preset: PermissionPreset }
	| { event: "finished"; result: DelegateResult }
	| { event: "done"; results: DelegateResult[] }
	| { event: "error"; error: string };

/** Body for `POST /api/delegate/stream`. */
export interface DelegateRequest {
	caps?: DelegationCaps;
	delegates: DelegateSpec[];
	/** Depth of these delegates (top-level parent delegating is depth 1). */
	depth?: number;
}

/**
 * Open the delegation stream and invoke `onEvent` for each parsed SSE event.
 *
 * Resolves when the stream closes (after the terminal `done`/`error`). Rejects
 * if the request itself fails (non-2xx) or the body cannot be read. Pass a
 * `signal` to cancel an in-flight fan-out.
 */
export async function streamDelegation(
	target: ApiTarget,
	body: DelegateRequest,
	onEvent: (event: DelegateEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/delegate/stream"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify(body),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`delegation failed: ${resp.status}`);
	}
	if (!resp.body) {
		throw new Error("delegation stream returned no body");
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	// SSE frames are separated by a blank line; each frame's `data:` lines carry
	// one JSON event. Parse frame-by-frame so partial chunks are buffered.
	const flush = (frame: string) => {
		const dataLines = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim());
		if (dataLines.length === 0) {
			return;
		}
		const payload = dataLines.join("\n");
		try {
			onEvent(JSON.parse(payload) as DelegateEvent);
		} catch {
			// Ignore malformed frames rather than aborting the whole stream.
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf("\n\n");
		while (sep !== -1) {
			flush(buffer.slice(0, sep));
			buffer = buffer.slice(sep + 2);
			sep = buffer.indexOf("\n\n");
		}
	}
	// Flush any trailing frame without a terminating blank line.
	if (buffer.trim().length > 0) {
		flush(buffer);
	}
}
