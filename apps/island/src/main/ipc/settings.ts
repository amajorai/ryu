// IPC handlers bridging the renderer to the persisted island settings.
//
// The settings panel reads service endpoints (Core/Shadow URLs + optional token)
// and engine tunables (cadence/cooldown), and writes patches back. Persistence
// lives in the config service so a single JSON file under `userData` is the
// source of truth for both the service clients and the proactive engine.

import { ipcMain } from "electron";
import { IPC, type IslandSettingsPatch } from "../../shared/ipc.ts";
import { getSettings, saveSettings } from "../services/config.ts";

/** Register the settings IPC handlers. */
export function registerSettingsIpc(): void {
	ipcMain.handle(IPC.settings.get, () => getSettings());
	ipcMain.handle(IPC.settings.set, (_event, patch: IslandSettingsPatch) =>
		saveSettings(patch)
	);
}
