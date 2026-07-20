// Main-process client for Ryu Core's plugin (Ryu App / Companion) host bridge.
//
// The renderer mounts `@ryu/app-host`'s sandboxed iframe and implements the
// privileged host services, but it cannot reach Core directly (CORS excludes
// Electron origins), so every Core HTTP call for the host bridge runs here and is
// reached over IPC. This mirrors the desktop `apps/desktop/src/lib/api/plugins.ts`
// transport, adapted to island's main-process Core client (`config.ts` base URL +
// bearer token) and its streaming pattern (`chatStream` in `core.ts`).

import { randomUUID } from "node:crypto";
import type {
	PluginCompanion,
	PluginContributionsResult,
	PluginCoreHttpRequest,
	PluginCoreHttpResult,
	PluginHostErrorCode,
	PluginHostInvokeResult,
	PluginHostStreamEndEvent,
	PluginHostStreamHandle,
	PluginUiBundleResult,
	PluginView,
} from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { SseDecoder } from "./sse.ts";

/** Short timeout for the contributions / ui-bundle probes. */
const PROBE_TIMEOUT_MS = 5000;
/** Longer timeout for a one-shot host-bridge invoke (may run a sub-agent). */
const INVOKE_TIMEOUT_MS = 120_000;

/** Sink the IPC layer wires to `webContents.send` for the streaming path. */
export interface HostStreamSink {
	chunk(delta: string): void;
	end(event: PluginHostStreamEndEvent): void;
}

/** In-flight host streams keyed by stream id, for abort. */
const activeStreams = new Map<string, AbortController>();

function reasonFromError(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

/** Fetch with an abort-based timeout. Rethrows so callers can map to a reason. */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** Map an HTTP status to the closed host-bridge error code (fallback when the
 *  response body carries no explicit code). Mirrors the desktop `codeForStatus`. */
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

/** Wire shape of a companion (snake_case from Rust serde). */
interface PluginCompanionWire {
	approved_grants?: string[];
	has_ui?: boolean;
	icon?: string;
	id?: unknown;
	label?: unknown;
	name?: unknown;
	plugin_id?: string;
	shortcut?: string;
}

/** Wire shape of a declarative-view contribution (Core tags each with `plugin`). */
interface PluginViewWire {
	id?: unknown;
	plugin?: unknown;
	spec?: unknown;
	title?: unknown;
	view?: unknown;
}

/** Project a wire view contribution to {@link PluginView}. Requires a string `id`
 *  and a `view` discriminant; the `spec` is forwarded verbatim (the host renderer
 *  runs `validateView` and degrades unknown/malformed specs, so the main process
 *  stays a dumb pipe here — exactly like the desktop client's `views: json.views`). */
function toPluginView(w: PluginViewWire): PluginView | null {
	if (typeof w.id !== "string" || typeof w.view !== "string") {
		return null;
	}
	return {
		id: w.id,
		view: w.view,
		title: typeof w.title === "string" ? w.title : undefined,
		plugin: typeof w.plugin === "string" ? w.plugin : undefined,
		spec: w.spec as PluginView["spec"],
	};
}

function toPluginCompanion(w: PluginCompanionWire): PluginCompanion | null {
	if (typeof w.id !== "string") {
		return null;
	}
	return {
		id: w.id,
		name: typeof w.name === "string" ? w.name : w.id,
		label: typeof w.label === "string" ? w.label : w.id,
		icon: typeof w.icon === "string" ? w.icon : null,
		shortcut: typeof w.shortcut === "string" ? w.shortcut : null,
		pluginId: w.plugin_id ?? "",
		approvedGrants: Array.isArray(w.approved_grants) ? w.approved_grants : [],
		hasUi: w.has_ui === true,
	};
}

/**
 * `GET /api/plugins/contributions` — the enabled plugins' declarative
 * contributions, projected to the two surfaces the island host renders: companion
 * apps (sandboxed UI bundles) and declarative `views` (host-rendered Raycast tier).
 * Never rejects to the caller.
 */
export async function pluginContributions(): Promise<PluginContributionsResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/plugins/contributions`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			companions?: PluginCompanionWire[];
			views?: PluginViewWire[];
		};
		const companions: PluginCompanion[] = [];
		for (const raw of data.companions ?? []) {
			const mapped = toPluginCompanion(raw);
			if (mapped) {
				companions.push(mapped);
			}
		}
		const views: PluginView[] = [];
		for (const raw of data.views ?? []) {
			const mapped = toPluginView(raw);
			if (mapped) {
				views.push(mapped);
			}
		}
		return { available: true, companions, views };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * `GET /api/plugins/:id/ui-bundle` — an enabled plugin's bundled UI code. `code`
 * is null when the plugin has no bundle / is not enabled (Core answers 404). The
 * host holds the token; the plugin frame never does. Never rejects to the caller.
 */
export async function pluginUiBundle(
	pluginId: string
): Promise<PluginUiBundleResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/plugins/${encodeURIComponent(pluginId)}/ui-bundle`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS
		);
		if (resp.status === 404) {
			return { available: true, code: null };
		}
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { code?: unknown };
		return {
			available: true,
			code: typeof data.code === "string" ? data.code : null,
		};
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/**
 * `POST /api/plugins/:id/host` — invoke ONE app host-bridge method
 * (`model.complete` / `agent.run` / `storage.*`) for an enabled, grant-approved
 * plugin. Returns a discriminated result rather than throwing: `ipcMain.handle`
 * cannot serialize a thrown error's `.code`, so the renderer transport
 * reconstructs a `PluginHostError` from `{ ok:false, code, message }`.
 */
export async function pluginHostInvoke(
	pluginId: string,
	method: string,
	args: unknown
): Promise<PluginHostInvokeResult> {
	const { coreBaseUrl } = loadConfig();
	let resp: Response;
	try {
		resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/plugins/${encodeURIComponent(pluginId)}/host`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ method, args }),
			},
			INVOKE_TIMEOUT_MS
		);
	} catch (error) {
		return { ok: false, code: "server_error", message: reasonFromError(error) };
	}
	if (!resp.ok) {
		let code = codeForStatus(resp.status);
		let message = `host bridge ${method} failed: ${resp.status}`;
		try {
			const body = (await resp.json()) as {
				error?: { code?: string; message?: string };
			};
			if (body.error) {
				if (typeof body.error.message === "string") {
					message = body.error.message;
				}
				if (typeof body.error.code === "string") {
					code = body.error.code as PluginHostErrorCode;
				}
			}
		} catch {
			// Non-JSON error body: keep the status-derived code + message.
		}
		return { ok: false, code, message };
	}
	const json = (await resp.json().catch(() => ({}))) as { result?: unknown };
	return { ok: true, result: json.result };
}

/** HTTP methods a declarative view action may use. Mirrors the vocabulary's
 *  `VIEW_ACTION_HTTP_METHODS` (`@ryu/app-host/views`) — duplicated here because the
 *  main process stays free of app-host imports (it is Core plumbing, not a renderer). */
const CORE_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Authenticated Core HTTP on behalf of a declarative view (the http-action tier +
 * the view `source` fetch). Defense in depth: the renderer already refuses
 * non-`/api/` paths (`isCoreApiPath`), but this hop holds the node token, so it
 * re-validates the path shape and method allowlist before fetching. Never rejects.
 */
export async function pluginCoreHttp(
	req: PluginCoreHttpRequest
): Promise<PluginCoreHttpResult> {
	const method = req.method.toUpperCase();
	if (!CORE_HTTP_METHODS.has(method)) {
		return {
			ok: false,
			code: "invalid_args",
			message: `unsupported method '${req.method}'`,
		};
	}
	if (
		!req.path.startsWith("/api/") ||
		req.path.split("/").some((segment) => segment === "..")
	) {
		return {
			ok: false,
			code: "invalid_args",
			message: `view http path must start with /api/: ${req.path}`,
		};
	}
	const { coreBaseUrl } = loadConfig();
	let resp: Response;
	try {
		resp = await fetchWithTimeout(
			`${coreBaseUrl}${req.path}`,
			{
				method,
				headers: coreHeaders(
					req.body === undefined
						? undefined
						: { "Content-Type": "application/json" }
				),
				body: req.body === undefined ? undefined : JSON.stringify(req.body),
			},
			INVOKE_TIMEOUT_MS
		);
	} catch (error) {
		return { ok: false, code: "server_error", message: reasonFromError(error) };
	}
	if (!resp.ok) {
		return {
			ok: false,
			code: codeForStatus(resp.status),
			message: `${req.path} failed: ${resp.status}`,
		};
	}
	const data: unknown = await resp.json().catch(() => null);
	return { ok: true, status: resp.status, data };
}

/**
 * Start a streaming `agent.run` (`POST /api/plugins/:id/host/stream`). Returns a
 * handle immediately; reply tokens and the terminal event are delivered through
 * `sink`. Aborting is done via {@link abortPluginHostStream}. Never rejects to the
 * caller — a failure is signalled through `sink.end` with `reason: "error"`.
 */
export function startPluginHostStream(
	pluginId: string,
	input: unknown,
	sink: HostStreamSink
): PluginHostStreamHandle {
	const streamId = randomUUID();
	const controller = new AbortController();
	activeStreams.set(streamId, controller);
	runHostStream(streamId, pluginId, input, sink, controller).catch(() => {
		// `runHostStream` never rejects; guard anyway.
	});
	return { streamId };
}

async function runHostStream(
	streamId: string,
	pluginId: string,
	input: unknown,
	sink: HostStreamSink,
	controller: AbortController
): Promise<void> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetch(
			`${coreBaseUrl}/api/plugins/${encodeURIComponent(pluginId)}/host/stream`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ method: "agent.run", args: input }),
				signal: controller.signal,
			}
		);
		if (!(resp.ok && resp.body)) {
			finishStream(streamId, sink, {
				streamId,
				reason: "error",
				code: codeForStatus(resp.status),
				error: `host stream ${pluginId} failed: ${resp.status}`,
			});
			return;
		}
		const errorText = await pumpHostStream(resp.body, sink, streamId);
		if (errorText !== null) {
			finishStream(streamId, sink, {
				streamId,
				reason: "error",
				code: "server_error",
				error: errorText,
			});
			return;
		}
		finishStream(streamId, sink, { streamId, reason: "done" });
	} catch (error) {
		if (controller.signal.aborted) {
			finishStream(streamId, sink, { streamId, reason: "aborted" });
			return;
		}
		finishStream(streamId, sink, {
			streamId,
			reason: "error",
			code: "server_error",
			error: reasonFromError(error),
		});
	}
}

/**
 * Drain the SSE body, pushing each `text-delta` to `sink.chunk`. Returns the error
 * text of the first `error` part (so the caller ends the stream with an error), or
 * `null` when the stream completed cleanly.
 */
async function pumpHostStream(
	body: ReadableStream<Uint8Array>,
	sink: HostStreamSink,
	streamId: string
): Promise<string | null> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	const emit = (part: {
		type: string;
		delta?: unknown;
		errorText?: unknown;
	}): string | null | undefined => {
		if (part.type === "text-delta" && typeof part.delta === "string") {
			sink.chunk(part.delta);
			return undefined;
		}
		if (part.type === "error") {
			return typeof part.errorText === "string"
				? part.errorText
				: "agent stream error";
		}
		return undefined;
	};
	let done = false;
	while (!done) {
		const { value, done: streamDone } = await reader.read();
		if (streamDone) {
			break;
		}
		const chunk = decoder.decode(value, { stream: true });
		for (const event of sse.push(chunk)) {
			if (event.kind === "done") {
				done = true;
				break;
			}
			const err = emit(event.part);
			if (typeof err === "string") {
				return err;
			}
		}
	}
	for (const event of sse.flush()) {
		if (event.kind === "part") {
			const err = emit(event.part);
			if (typeof err === "string") {
				return err;
			}
		}
	}
	// `streamId` is threaded only so a future per-stream diagnostic can reference
	// it; the sink already carries it on every event.
	void streamId;
	return null;
}

function finishStream(
	streamId: string,
	sink: HostStreamSink,
	event: PluginHostStreamEndEvent
): void {
	if (!activeStreams.has(streamId)) {
		return;
	}
	activeStreams.delete(streamId);
	sink.end(event);
}

/** Abort an in-flight host stream by id. No-op when the id is unknown. */
export function abortPluginHostStream(streamId: string): void {
	activeStreams.get(streamId)?.abort();
}
