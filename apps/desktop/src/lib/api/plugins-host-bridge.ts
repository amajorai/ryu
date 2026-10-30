import { resolveOwnAppPath } from "./app-request.ts";
import { type ApiTarget, authenticatedFetch, makeHeaders } from "./client.ts";
import {
	type PluginValue,
	pluginRecord,
	pluginStringField,
} from "./plugin-wire-values.ts";
import { parsePluginResponse } from "./plugins-app-response-contracts.ts";
import {
	hostArgumentsSchema,
	hostErrorCodeSchema,
	hostResponseSchema,
	hostStreamFrameSchema,
} from "./plugins-catalog-response-contracts.ts";

/** A closed error code the app host-bridge surfaces to a companion frame. Mirrors
 *  the host `WidgetRpcErrorCode` so `toRpcError` (host rpc) forwards `code` intact. */
export type PluginHostErrorCode =
	| "denied"
	| "not_found"
	| "over_budget"
	| "server_error"
	| "invalid_args";

/** Carries a {@link PluginHostErrorCode} so the host RPC layer relays a structured
 *  `{ code, message }` (not a bare string) back to the sandboxed app. */
export class PluginHostError extends Error {
	code: PluginHostErrorCode;
	constructor(code: PluginHostErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "PluginHostError";
	}
}

/** The exact reply Core's app host bridge gives for a method it does not know
 *  (`plugin_bridge_api::plugin_bridge_dispatch`, pinned by its
 *  `unknown_method_reply_is_pinned` test). */
export function unknownHostMethodMessage(method: string): string {
	return `unknown host method '${method}'`;
}

/**
 * Run a host-bridge call, falling back to `legacyCall` ONLY when Core is too old
 * to know `method`: a {@link PluginHostError} with code `invalid_args` and exactly
 * Core's unknown-method message. Every other failure (`denied`, `not_found`,
 * `server_error`, any other `invalid_args`) is re-thrown without the legacy call,
 * so a newer Core's grant or user-permission refusal never fails open to a
 * host-direct route.
 */
export async function withLegacyBridgeFallback<T>(
	method: string,
	bridgeCall: () => Promise<T>,
	legacyCall: () => Promise<T>
): Promise<T> {
	try {
		return await bridgeCall();
	} catch (error) {
		if (
			error instanceof PluginHostError &&
			error.code === "invalid_args" &&
			error.message === unknownHostMethodMessage(method)
		) {
			return await legacyCall();
		}
		throw error;
	}
}

/** Map an HTTP status to the closed error code (the endpoint already returns a code
 *  in its body; this is the fallback when the body is missing/unparseable). */
function codeForStatus(status: number): PluginHostErrorCode {
	switch (status) {
		case 403:
			return "denied";
		case 404:
			return "not_found";
		case 429:
			return "over_budget";
		case 400:
		case 422:
			return "invalid_args";
		default:
			return "server_error";
	}
}

/**
 * `POST /api/plugins/:id/host` — invoke ONE app host-bridge method (`model.complete`
 * / `agent.run` / `storage.*`) for an enabled, grant-approved app. The desktop host
 * calls this on the frame's behalf: it holds the node token; the null-origin iframe
 * (CSP `connect-src 'none'`) has NO network path and reaches here only via the
 * capability-gated MessagePort RPC. `method` is the DOTTED wire name Core maps to the
 * bridge (`model.complete`/`agent.run`/`storage.get`/…, see `bridge_path_for`); `args`
 * is the already-validated, snake-keyed object forwarded verbatim. Throws
 * {@link PluginHostError} on non-2xx so the host relays a structured code to the app.
 */
export async function pluginHostInvoke(
	target: ApiTarget,
	pluginId: string,
	method: string,
	args: Parameters<typeof hostArgumentsSchema.parse>[0]
): Promise<PluginValue | undefined> {
	let resp: Response;
	try {
		resp = await authenticatedFetch(
			target,
			`/api/plugins/${encodeURIComponent(pluginId)}/host`,
			{
				method: "POST",
				headers: makeHeaders(target.token, target.userJwt),
				body: JSON.stringify({ method, args: hostArgumentsSchema.parse(args) }),
			}
		);
	} catch (e) {
		throw new PluginHostError(
			"server_error",
			e instanceof Error ? e.message : "host bridge unreachable"
		);
	}
	if (!resp.ok) {
		let code = codeForStatus(resp.status);
		let message = `host bridge ${method} failed: ${resp.status}`;
		try {
			const body = pluginRecord(await resp.json());
			const error = pluginRecord(body?.error);
			const errorMessage = pluginStringField(error?.message);
			if (errorMessage !== undefined) {
				message = errorMessage;
			}
			const errorCode = hostErrorCodeSchema.safeParse(error?.code);
			if (errorCode.success) {
				code = errorCode.data;
			}
		} catch {
			// Non-JSON error body: keep the status-derived code + message.
		}
		throw new PluginHostError(code, message);
	}
	const json = parsePluginResponse(hostResponseSchema, await resp.json());
	return json.result;
}

/**
 * `POST /api/plugins/:id/host/stream` — stream a tool-using `agent.run` for a
 * full-page app. The desktop host holds the token and reads the governance-filtered
 * SSE, delivering each reply token to `onChunk`. Resolves at the terminal `[DONE]`;
 * throws {@link PluginHostError} on an `error` frame or a non-2xx status. `signal`
 * aborts the fetch (the frame cancels), and Core lets the detached turn finish
 * server-side, exactly like a normal chat client disconnect.
 */
export async function pluginHostInvokeStream(
	target: ApiTarget,
	pluginId: string,
	input: Parameters<typeof hostArgumentsSchema.parse>[0],
	opts: { onChunk: (delta: string) => void; signal?: AbortSignal }
): Promise<void> {
	let resp: Response;
	try {
		resp = await authenticatedFetch(
			target,
			`/api/plugins/${encodeURIComponent(pluginId)}/host/stream`,
			{
				method: "POST",
				headers: makeHeaders(target.token, target.userJwt),
				body: JSON.stringify({
					method: "agent.run",
					args: hostArgumentsSchema.parse(input),
				}),
				signal: opts.signal,
			}
		);
	} catch (e) {
		throw new PluginHostError(
			"server_error",
			e instanceof Error ? e.message : "host stream unreachable"
		);
	}
	if (!(resp.ok && resp.body)) {
		throw new PluginHostError(
			codeForStatus(resp.status),
			`host stream ${pluginId} failed: ${resp.status}`
		);
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		if (opts.signal?.aborted) {
			return;
		}
		let chunk = await reader.read();
		while (!(chunk.done || opts.signal?.aborted)) {
			buf += decoder.decode(chunk.value, { stream: true });
			let boundary = buf.indexOf("\n\n");
			while (boundary !== -1 && !opts.signal?.aborted) {
				const frame = buf.slice(0, boundary);
				buf = buf.slice(boundary + 2);
				const data = frame.startsWith("data:")
					? frame.slice("data:".length).trim()
					: null;
				if (data === "[DONE]") {
					return;
				}
				if (data !== null && data.length > 0) {
					const parsed = (() => {
						try {
							return hostStreamFrameSchema.safeParse(JSON.parse(data));
						} catch {
							return hostStreamFrameSchema.safeParse({});
						}
					})();
					const frameValue = parsed.success ? parsed.data : {};
					if (
						frameValue.type === "text-delta" &&
						frameValue.delta !== undefined
					) {
						opts.onChunk(frameValue.delta);
					} else if (frameValue.type === "error") {
						throw new PluginHostError(
							"server_error",
							frameValue.errorText ?? "agent stream error"
						);
					}
				}
				boundary = buf.indexOf("\n\n");
			}
			if (opts.signal?.aborted) {
				return;
			}
			chunk = await reader.read();
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * `GET /api/ext/<plugin id><path>` — read an SSE route on the calling companion's
 * OWN sidecar through the generic ext-proxy and forward each raw `data:` payload
 * VERBATIM to `onFrame`. The plugin id is host-owned; `path` is relative to the
 * sidecar's mount and validated against it before any credential is attached.
 * Serves the `finetune.stream` host-API verb (the sidecar's
 * `/api/finetune/:id/stream` progress frames), which Core no longer bridges.
 * Resolves when the stream closes; `signal` aborts the fetch.
 */
export async function ownAppEventStream(
	target: ApiTarget,
	pluginId: string,
	path: string,
	opts: { onFrame: (data: string) => void; signal?: AbortSignal }
): Promise<void> {
	const resolved = resolveOwnAppPath(pluginId, path);
	if (!resolved) {
		throw new PluginHostError(
			"invalid_args",
			"Refusing an app stream outside its own sidecar mount."
		);
	}
	let resp: Response;
	try {
		resp = await authenticatedFetch(target, resolved, {
			method: "GET",
			headers: makeHeaders(target.token, target.userJwt),
			signal: opts.signal,
		});
	} catch (e) {
		throw new PluginHostError(
			"server_error",
			e instanceof Error ? e.message : "app stream unreachable"
		);
	}
	if (!(resp.ok && resp.body)) {
		throw new PluginHostError(
			codeForStatus(resp.status),
			`app stream ${path} failed: ${resp.status}`
		);
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		if (opts.signal?.aborted) {
			return;
		}
		let chunk = await reader.read();
		while (!(chunk.done || opts.signal?.aborted)) {
			buf += decoder.decode(chunk.value, { stream: true });
			let boundary = buf.indexOf("\n\n");
			while (boundary !== -1 && !opts.signal?.aborted) {
				const frame = buf.slice(0, boundary);
				buf = buf.slice(boundary + 2);
				// A frame may carry `event: <name>` and `data: <json>` lines; forward the
				// data payload(s) verbatim. The app reads `state`/`step`/`loss` from the JSON.
				for (const line of frame.split("\n")) {
					if (opts.signal?.aborted) {
						return;
					}
					if (line.startsWith("data:")) {
						const data = line.slice("data:".length).trim();
						if (data.length > 0) {
							opts.onFrame(data);
						}
					}
				}
				boundary = buf.indexOf("\n\n");
			}
			if (opts.signal?.aborted) {
				return;
			}
			chunk = await reader.read();
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/**
 * `POST /api/plugins/activation-event` — fire an `onCommand:<id>` activation
 * event so command-gated plugins wake when the desktop command palette runs one
 * of their contributed commands. Best-effort: Core only validates the
 * `onCommand:` prefix, so an unknown id is a harmless no-op. Callers should not
 * block the command UX on this — swallow failures.
 */
export async function fireActivationEvent(
	target: ApiTarget,
	commandId: string
): Promise<void> {
	const resp = await authenticatedFetch(
		target,
		"/api/plugins/activation-event",
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ event: `onCommand:${commandId}` }),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/plugins/activation-event failed: ${resp.status}`);
	}
}
