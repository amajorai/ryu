// IPC bridge for the island's text-to-speech: the `island-tts` preference plus a
// `speak` invoke that proxies Core's `/api/voice/speak`.
//
// Mirrors `ipc/voice.ts` for the pref (one-shot read + pushed `changed` event)
// and `ipc/core.ts` for the synthesis call (all Core HTTP runs in the main
// process; the renderer cannot reach Core directly because of CORS). The renderer
// parses the pref blob with `shared/tts.ts` and plays the returned WAV bytes.

import { type BrowserWindow, ipcMain } from "electron";
import { type CoreSpeakRequest, IPC } from "../../shared/ipc.ts";
import { ISLAND_TTS_PREF_KEY } from "../../shared/tts.ts";
import { speak } from "../services/core.ts";
import {
	getPreferenceRaw,
	subscribePreferenceChanges,
} from "../services/preferences.ts";

/** Register the TTS IPC handlers. Safe to call once. */
export function registerTtsIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.tts.get, () => getPreferenceRaw(ISLAND_TTS_PREF_KEY));
	ipcMain.handle(IPC.tts.speak, (_event, req: CoreSpeakRequest) => speak(req));

	subscribePreferenceChanges(ISLAND_TTS_PREF_KEY, (value) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.tts.changed, value);
		}
	});
}
