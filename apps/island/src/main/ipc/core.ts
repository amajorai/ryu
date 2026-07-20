// IPC handlers bridging the renderer to the main-process Core client.
//
// One-shot requests use `ipcMain.handle` (invoke/return). The streaming chat
// path uses `ipcMain.handle` to kick off a run and returns a handle, then
// pushes parts to the renderer via `webContents.send` on the `core:streamPart`
// and `core:streamEnd` channels keyed by stream id. Abort is a separate invoke.

import { type BrowserWindow, ipcMain } from "electron";
import {
	type CoreChatStreamRequest,
	type CoreCompletionsRequest,
	type CoreToolCallRequest,
	type CoreTranscribeRequest,
	IPC,
} from "../../shared/ipc.ts";
import {
	abortStream,
	acpConfig,
	agents,
	callTool,
	chatStream,
	completions,
	conversations,
	engineModels,
	health,
	type StreamSink,
	sidecarStart,
	sidecarStatus,
	transcribe,
} from "../services/core.ts";

/**
 * Register all Core IPC handlers. `getWindow` returns the live renderer window
 * (or `null`) so streamed parts always reach the current window even after a
 * macOS re-activation recreates it.
 */
export function registerCoreIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.core.health, () => health());

	ipcMain.handle(
		IPC.core.chatStreamStart,
		(_event, req: CoreChatStreamRequest) => {
			const send = (channel: string, payload: unknown): void => {
				const win = getWindow();
				if (win && !win.isDestroyed()) {
					win.webContents.send(channel, payload);
				}
			};
			const sink: StreamSink = {
				part(event) {
					send(IPC.core.streamPart, event);
				},
				end(event) {
					send(IPC.core.streamEnd, event);
				},
			};
			return chatStream(req, sink);
		}
	);

	ipcMain.handle(IPC.core.chatStreamAbort, (_event, streamId: string) => {
		abortStream(streamId);
	});

	ipcMain.handle(IPC.core.completions, (_event, req: CoreCompletionsRequest) =>
		completions(req)
	);

	ipcMain.handle(IPC.core.callTool, (_event, req: CoreToolCallRequest) =>
		callTool(req)
	);

	ipcMain.handle(IPC.core.sidecarStatus, () => sidecarStatus());

	ipcMain.handle(IPC.core.sidecarStart, (_event, name: string) =>
		sidecarStart(name)
	);

	ipcMain.handle(IPC.core.transcribe, (_event, req: CoreTranscribeRequest) =>
		transcribe(req.audio, req.engine)
	);

	ipcMain.handle(IPC.core.agents, () => agents());

	ipcMain.handle(IPC.core.acpConfig, (_event, agentId: string) =>
		acpConfig(agentId)
	);

	ipcMain.handle(IPC.core.engineModels, () => engineModels());

	ipcMain.handle(IPC.core.conversations, () => conversations());
}
