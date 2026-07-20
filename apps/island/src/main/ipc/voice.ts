// IPC bridge for voice-input settings. Exposes a one-shot read (`voice:get`) and
// starts a long-lived SSE subscription to Core, pushing each new voice-input blob
// to the renderer on `voice:changed`. The blob stays an opaque JSON string here;
// the renderer parses it with `shared/voice.ts`. The push-to-talk shortcut itself
// is registered in the main bootstrap (`main/index.ts`), which also owns the
// `voice:toggle` send when the shortcut fires.

import { type BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { loadConfig } from "../services/config.ts";
import { getVoicePrefsRaw, subscribeVoiceChanges } from "../services/voice.ts";

/**
 * Register the voice IPC handler and start the Core SSE subscription.
 * `getWindow` returns the live renderer window so changes always reach the
 * current window even after a macOS re-activation recreates it.
 */
export function registerVoiceIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.voice.get, () => getVoicePrefsRaw());

	// The Core node target for the renderer's realtime voice-mode WebSocket. The
	// token is the same node token the island already uses for every Core call, so
	// exposing it here doesn't widen trust. Follow-up: gate voice mode behind the
	// existing `chat` consent capability (voice mode is spoken chat).
	ipcMain.handle(IPC.voice.target, () => {
		const cfg = loadConfig();
		return { url: cfg.coreBaseUrl, token: cfg.coreToken };
	});

	subscribeVoiceChanges((value) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.voice.changed, value);
		}
	});
}
