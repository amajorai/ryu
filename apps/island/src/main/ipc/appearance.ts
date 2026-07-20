// IPC bridge for the island appearance. Exposes a one-shot read (`appearance:get`)
// so the renderer can pick its shape styling and footprint-reporting behaviour on
// mount. A change to the window *mode* recreates + reloads the window (see
// `main/index.ts`), so the renderer never needs a live change event here — its
// next mount re-reads the current value.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { getAppearanceRaw } from "../services/appearance.ts";

/** Register the appearance IPC handler. Call exactly once. */
export function registerAppearanceIpc(): void {
	ipcMain.handle(IPC.appearance.get, () => getAppearanceRaw());
}
