// IPC bridge for the island's agent-routing preference (`island-agents`).
//
// Mirrors `ipc/voice.ts`: a one-shot read plus a pushed `changed` event so the
// renderer re-routes its chat live when the desktop edits the setting. The blob
// stays an opaque JSON string; the renderer parses it with `shared/agents.ts`.

import { type BrowserWindow, ipcMain } from "electron";
import { ISLAND_AGENTS_PREF_KEY } from "../../shared/agents.ts";
import { IPC } from "../../shared/ipc.ts";
import {
	getPreferenceRaw,
	setPreferenceRaw,
	subscribePreferenceChanges,
} from "../services/preferences.ts";

/** Register the agent-routing IPC handlers. Safe to call once. */
export function registerAgentsIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.agents.get, () =>
		getPreferenceRaw(ISLAND_AGENTS_PREF_KEY)
	);

	// Persist a new routing blob (the renderer's Tab-cycled agent pick). The write
	// echoes back over the SSE subscription below and re-broadcasts as `changed`,
	// keeping every reader (chat + recording pill) on one source of truth.
	ipcMain.handle(IPC.agents.set, (_event, raw: string) =>
		setPreferenceRaw(ISLAND_AGENTS_PREF_KEY, raw)
	);

	subscribePreferenceChanges(ISLAND_AGENTS_PREF_KEY, (value) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.agents.changed, value);
		}
	});
}
