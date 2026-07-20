// IPC handler for renderer-driven window visibility toggling.
//
// The tray and the global hotkey toggle the window directly in the main process;
// this channel lets the renderer (e.g. a "minimize" affordance in the expanded
// panel) do the same through the shared visibility controller.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { toggleWindow } from "../visibility.ts";

/** Register the window-visibility IPC handler. */
export function registerWindowIpc(): void {
	ipcMain.on(IPC.window.toggle, () => toggleWindow());
}
