// IPC bridge for theme sync. Exposes a one-shot read (`theme:get`) and starts a
// long-lived SSE subscription to Core, pushing each new theme blob to the
// renderer on `theme:changed`. The blob stays an opaque JSON string here; the
// renderer parses + applies it with `@ryu/ui/theme`.

import { type BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { getThemePrefsRaw, subscribeThemeChanges } from "../services/theme.ts";

/**
 * Register the theme IPC handler and start the Core SSE subscription.
 * `getWindow` returns the live renderer window so changes always reach the
 * current window even after a macOS re-activation recreates it.
 */
export function registerThemeIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.theme.get, () => getThemePrefsRaw());

	subscribeThemeChanges((value) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.theme.changed, value);
		}
	});
}
