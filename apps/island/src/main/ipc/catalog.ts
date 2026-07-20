// IPC handlers bridging the renderer to the main-process catalog client.
//
// All four channels are one-shot invoke/return; the underlying service methods
// never reject (they resolve to result envelopes), so these handlers just
// forward. Browse/install logic lives in Core.

import { ipcMain } from "electron";
import {
	type CatalogInstallRequest,
	type CatalogListRequest,
	type CatalogSelectSourceRequest,
	IPC,
} from "../../shared/ipc.ts";
import { install, list, selectSource, sources } from "../services/catalog.ts";

/** Register the marketplace catalog IPC handlers. Call once. */
export function registerCatalogIpc(): void {
	ipcMain.handle(IPC.catalog.sources, (_event, kind: "skill" | "mcp") =>
		sources(kind)
	);

	ipcMain.handle(IPC.catalog.list, (_event, req: CatalogListRequest) =>
		list(req.kind, req.query)
	);

	ipcMain.handle(IPC.catalog.install, (_event, req: CatalogInstallRequest) =>
		install(req.kind, req.id)
	);

	ipcMain.handle(
		IPC.catalog.selectSource,
		(_event, req: CatalogSelectSourceRequest) => selectSource(req.kind, req.id)
	);
}
