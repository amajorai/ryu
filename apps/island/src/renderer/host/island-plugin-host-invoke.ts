// Renderer-side transport for the plugin (Ryu App / Companion) host bridge.
//
// Ported from the desktop `apps/desktop/src/lib/api/plugins.ts`
// `pluginHostInvoke` / `pluginHostInvokeStream`, but adapted to island: the
// renderer CANNOT fetch Core directly (CORS excludes Electron origins), so these
// thin wrappers delegate to the `window.island.plugins.*` IPC methods and the real
// HTTP runs in the main-process `services/plugin-host.ts`. The wire contract is
// identical — same `/api/plugins/:id/host` + `/host/stream` endpoints, same dotted
// method names, same `PluginHostError` code mapping — so `@ryu/app-host`'s host
// services are wired the same way as on desktop.

import type { PluginHostErrorCode } from "../../shared/ipc.ts";

/** Carries a {@link PluginHostErrorCode} so the host RPC layer relays a structured
 *  `{ code, message }` (not a bare string) back to the sandboxed app. Mirrors the
 *  desktop `PluginHostError`. */
export class PluginHostError extends Error {
	code: PluginHostErrorCode;
	constructor(code: PluginHostErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = "PluginHostError";
	}
}

/**
 * Invoke ONE app host-bridge method (`model.complete` / `agent.run` / `storage.*`)
 * for an enabled, grant-approved plugin, keyed by the OWNING plugin id. The
 * main-process client holds the node token; the sandboxed frame never does. Throws
 * {@link PluginHostError} on a failed invoke so `@ryu/app-host` relays a structured
 * code to the app.
 */
export async function pluginHostInvoke(
	pluginId: string,
	method: string,
	args: unknown
): Promise<unknown> {
	const result = await window.island.plugins.hostInvoke({
		pluginId,
		method,
		args,
	});
	if (!result.ok) {
		throw new PluginHostError(result.code, result.message);
	}
	return result.result;
}

/**
 * Stream a tool-using `agent.run` for a full-page app. The main-process client
 * reads the governance-filtered SSE and pushes each reply token here via the
 * `plugins:hostStreamChunk` event; this resolves at the terminal end event and
 * throws {@link PluginHostError} on an error end. `signal` aborts the underlying
 * request (the frame cancels), exactly like a normal chat-client disconnect.
 */
export function pluginHostInvokeStream(
	pluginId: string,
	input: unknown,
	opts: { onChunk: (delta: string) => void; signal?: AbortSignal }
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let streamId: string | null = null;
		let settled = false;

		const cleanup = (): void => {
			offChunk();
			offEnd();
			opts.signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = (): void => {
			if (streamId) {
				window.island.plugins.abortHostStream(streamId).catch(() => {
					// Aborting a stream that already finished is a no-op; ignore.
				});
			}
		};

		const offChunk = window.island.plugins.onHostStreamChunk((event) => {
			if (event.streamId === streamId) {
				opts.onChunk(event.delta);
			}
		});

		const offEnd = window.island.plugins.onHostStreamEnd((event) => {
			if (event.streamId !== streamId || settled) {
				return;
			}
			settled = true;
			cleanup();
			if (event.reason === "error") {
				reject(
					new PluginHostError(
						event.code ?? "server_error",
						event.error ?? "agent stream error"
					)
				);
				return;
			}
			// Both a clean finish and an abort resolve: an abort is the frame
			// cancelling, not a failure to surface to the app.
			resolve();
		});

		if (opts.signal?.aborted) {
			onAbort();
		} else {
			opts.signal?.addEventListener("abort", onAbort);
		}

		window.island.plugins
			.startHostStream({ pluginId, input })
			.then((handle) => {
				streamId = handle.streamId;
				// No chunk/end event can arrive before `streamId` is set here: the main
				// process only `webContents.send`s stream events after `await fetch(...)`
				// inside `runHostStream`, which is strictly after the synchronous IPC
				// handler returned this `{ streamId }` reply. Electron delivers that
				// invoke reply before any send fetch's later settlement triggers, so the
				// id is always assigned first — no event buffering is needed. If the
				// caller aborted before the handle resolved, honour it now.
				if (opts.signal?.aborted) {
					onAbort();
				}
			})
			.catch((err: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(
					new PluginHostError(
						"server_error",
						err instanceof Error ? err.message : "host stream unreachable"
					)
				);
			});
	});
}
