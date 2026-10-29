import { getNotchGeometry } from "../notch.ts";
// IPC bridge for the island appearance. Exposes a one-shot read (`appearance:get`)
// so the renderer can pick its shape styling and footprint-reporting behaviour on
// mount. It answers with the Background main built the live window in, not a
// fresh Core read, so the renderer always styles for the window it is in (Core
// may hold a newer value mid-rebuild, or have refused the startup read). A change
// to the window *mode* recreates + reloads the window (see `main/index.ts`), so
// the renderer never needs a live change event here — its next mount re-reads.

import { ipcMain } from "electron";
import type { IslandBackground } from "../../shared/appearance.ts";
import { IPC } from "../../shared/ipc.ts";

/** Register the appearance IPC handler. Call exactly once. */
export function registerAppearanceIpc(
	builtBackground: () => IslandBackground
): void {
	ipcMain.handle(IPC.appearance.get, () =>
		JSON.stringify({ background: builtBackground() })
	);
	ipcMain.handle(IPC.appearance.notch, () => getNotchGeometry());
}
