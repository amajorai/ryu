// IPC bridge for auto-update. Exposes reads (app version, shared `auto-updates`
// pref, current update state), a write for the pref, and `quitAndInstall`. The
// service pushes `update:available` / `update:downloaded` events to the live
// renderer; this module wires the request/response handlers and starts the
// launch check via `initAutoUpdater`.

import { type BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import {
	getAppVersion,
	getAutoUpdateEnabled,
	getUpdateState,
	initAutoUpdater,
	quitAndInstall,
	setAutoUpdateEnabled,
} from "../services/update.ts";

/**
 * Register the update IPC handlers and start the auto-updater. `getWindow`
 * returns the live renderer window so update events always reach the current
 * window even after a recreation. Call exactly once.
 */
export function registerUpdateIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.update.getVersion, () => getAppVersion());
	ipcMain.handle(IPC.update.getAutoUpdate, () => getAutoUpdateEnabled());
	ipcMain.handle(IPC.update.setAutoUpdate, (_event, enabled: boolean) =>
		setAutoUpdateEnabled(enabled)
	);
	ipcMain.handle(IPC.update.getState, () => getUpdateState());
	ipcMain.on(IPC.update.quitAndInstall, () => quitAndInstall());

	initAutoUpdater(getWindow);
}
