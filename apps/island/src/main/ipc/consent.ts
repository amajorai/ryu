// IPC handlers bridging the renderer to the main-process consent store.
//
// The renderer reads consent (`consent:get`), grants/declines capabilities
// (`consent:set`), and subscribes to changes (`consent:changed`) so the first-run
// card and recording indicator stay in sync even when the tray flips a toggle.

import { type BrowserWindow, ipcMain } from "electron";
import { type ConsentPatch, IPC } from "../../shared/ipc.ts";
import {
	getConsent,
	onConsentChanged,
	setConsent,
} from "../services/consent.ts";

/**
 * Register consent IPC handlers and forward consent changes to the live window.
 * `getWindow` returns the current renderer window (or `null`) so changes reach it
 * even after a macOS re-activation recreates the window.
 */
export function registerConsentIpc(
	getWindow: () => BrowserWindow | null
): void {
	ipcMain.handle(IPC.consent.get, () => getConsent());
	ipcMain.handle(IPC.consent.set, (_event, patch: ConsentPatch) =>
		setConsent(patch)
	);

	onConsentChanged((state) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.consent.changed, state);
		}
	});
}
