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
	type PluginHostStreamStartRequest,
} from "../../shared/ipc.ts";
import {
	abortPluginHostStream,
	type HostStreamSink,
	pluginContributions,
	pluginCoreHttp,
	pluginHostInvoke,
	pluginUiBundle,
	startPluginHostStream,
} from "../services/plugin-host.ts";

/**
 * Register the plugin-host IPC handlers. `getWindow` returns the live renderer
 * window (or `null`) so streamed chunks always reach the current window even after
 * a macOS re-activation recreates it.
 */
export function registerPluginsIpc(
	getWindow: () => BrowserWindow | null
): void {
	ipcMain.handle(IPC.plugins.contributions, () => pluginContributions());

	ipcMain.handle(IPC.plugins.uiBundle, (_event, pluginId: string) =>
		pluginUiBundle(pluginId)
	);

	ipcMain.handle(
		IPC.plugins.hostInvoke,
		(_event, req: PluginHostInvokeRequest) =>
			pluginHostInvoke(req.pluginId, req.method, req.args)
	);

	ipcMain.handle(IPC.plugins.coreHttp, (_event, req: PluginCoreHttpRequest) =>
		pluginCoreHttp(req)
	);

	ipcMain.handle(
		IPC.plugins.hostStreamStart,
		(_event, req: PluginHostStreamStartRequest) => {
			const send = (channel: string, payload: unknown): void => {
				const win = getWindow();
				if (win && !win.isDestroyed()) {
					win.webContents.send(channel, payload);
				}
			};
			const sink: HostStreamSink = {
				chunk(delta) {
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
