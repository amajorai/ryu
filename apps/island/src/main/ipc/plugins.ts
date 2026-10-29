// IPC handlers bridging the renderer's plugin (Ryu App / Companion) host to the
// main-process Core plugin-host client.
//
// One-shot requests use `ipcMain.handle` (invoke/return). The streaming
// `agent.run` path kicks off a run and returns a handle, then pushes reply tokens
// to the renderer via `webContents.send` on the `plugins:hostStreamChunk` and
// `plugins:hostStreamEnd` channels keyed by stream id. Abort is a separate invoke.

import { type BrowserWindow, ipcMain } from "electron";
import {
	IPC,
	type PluginCoreHttpRequest,
	type PluginHostInvokeRequest,
	type PluginHostStreamChunkEvent,
	type PluginHostStreamEndEvent,
	type PluginHostStreamStartRequest,
} from "../../shared/ipc.ts";
import {
	coreConfigGeneration,
	onCoreConfigChange,
} from "../services/config.ts";
import {
	abortAllPluginHostStreams,
	abortPluginHostStream,
	type HostStreamSink,
	pluginContributions,
	pluginCoreHttp,
	pluginHostInvoke,
	startPluginHostStream,
} from "../services/plugin-host.ts";
import {
	abortUiBundleRead,
	readUiBundle,
} from "../services/ui-bundle-reads.ts";

/**
 * Register the plugin-host IPC handlers. `getWindow` returns the live renderer
 * window (or `null`) so streamed chunks always reach the current window even after
 * a macOS re-activation recreates it.
 */
export function registerPluginsIpc(
	getWindow: () => BrowserWindow | null
): void {
	onCoreConfigChange(() => {
		abortAllPluginHostStreams();
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.plugins.sourceChanged);
		}
	});
	ipcMain.handle(IPC.plugins.contributions, async () => {
		const generation = coreConfigGeneration();
		const result = await pluginContributions();
		if (generation !== coreConfigGeneration()) {
			return { available: false, reason: "Core configuration changed" };
		}
		return result.available
			? {
					...result,
					companions: result.companions.map((companion) => ({
						...companion,
						coreGeneration: generation,
					})),
					views: result.views.map((view) => ({
						...view,
						coreGeneration: generation,
					})),
				}
			: result;
	});

	ipcMain.handle(
		IPC.plugins.uiBundle,
		async (event, pluginId: string, requestId?: string) => {
			const generation = coreConfigGeneration();
			const result = await readUiBundle(event.sender, pluginId, requestId);
			if (generation !== coreConfigGeneration()) {
				return { available: false, reason: "Core configuration changed" };
			}
			return result.available
				? { ...result, coreGeneration: generation }
				: result;
		}
	);
	ipcMain.handle(IPC.plugins.uiBundleAbort, (event, requestId: string) =>
		abortUiBundleRead(event.sender.id, requestId)
	);

	ipcMain.handle(
		IPC.plugins.hostInvoke,
		async (_event, req: PluginHostInvokeRequest) => {
			if (req.coreGeneration !== coreConfigGeneration()) {
				return {
					ok: false,
					code: "denied",
					message: "Core configuration changed",
				};
			}
			const result = await pluginHostInvoke(req.pluginId, req.method, req.args);
			return req.coreGeneration === coreConfigGeneration()
				? result
				: { ok: false, code: "denied", message: "Core configuration changed" };
		}
	);

	ipcMain.handle(
		IPC.plugins.coreHttp,
		async (_event, req: PluginCoreHttpRequest) => {
			if (req.coreGeneration !== coreConfigGeneration()) {
				return {
					ok: false,
					code: "denied",
					message: "Core configuration changed",
				};
			}
			const result = await pluginCoreHttp(req);
			return req.coreGeneration === coreConfigGeneration()
				? result
				: { ok: false, code: "denied", message: "Core configuration changed" };
		}
	);

	ipcMain.handle(
		IPC.plugins.hostStreamStart,
		(_event, req: PluginHostStreamStartRequest) => {
			if (req.coreGeneration !== coreConfigGeneration()) {
				throw new Error("Core configuration changed");
			}
			const send = (
				channel: string,
				payload: PluginHostStreamChunkEvent | PluginHostStreamEndEvent
			): void => {
				const win = getWindow();
				if (win && !win.isDestroyed()) {
					win.webContents.send(channel, payload);
				}
			};
			const sink: HostStreamSink = {
				chunk(delta) {
					if (req.coreGeneration !== coreConfigGeneration()) {
						return;
					}
					send(IPC.plugins.hostStreamChunk, {
						streamId: handle.streamId,
						delta,
					});
				},
				end(event) {
					send(IPC.plugins.hostStreamEnd, event);
				},
			};
			const handle = startPluginHostStream(req.pluginId, req.input, sink);
			return handle;
		}
	);

	ipcMain.handle(IPC.plugins.hostStreamAbort, (_event, streamId: string) =>
		abortPluginHostStream(streamId)
	);
}
