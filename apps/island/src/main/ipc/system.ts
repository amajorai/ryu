// IPC handlers for OS integration: opening a URL in the default browser, and the
// native image picker behind the island's attach action.
//
// The command surface's smart-bar routes a typed query to a navigate/search/bang
// intent and asks the main process to open the resulting URL externally (the
// island has no browser of its own). Opening is gated to safe web schemes so a
// crafted `javascript:`/`file:` value can never be launched from the renderer.
//
// The attach action opens an image picker (parented to the island window so it is
// modal-attached), reads each chosen file into a data URL, and returns them. The
// renderer stages them on the composer and sends them to Core as image file-parts
// — the same multimodal path the desktop composer uses. Only images are offered:
// the island chat is text-only otherwise and the default agent has no file tools,
// so an arbitrary-file attach would be a dead button.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
	type BrowserWindow,
	dialog,
	ipcMain,
	type OpenDialogOptions,
	shell,
} from "electron";
import { IPC, type IslandAttachment } from "../../shared/ipc.ts";

/** Only these schemes may be handed to the OS; everything else is ignored. */
const SAFE_SCHEME_RE = /^https?:\/\//i;

/** Image extensions offered in the picker, mapped to their MIME type. */
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Read one image path into an attachment (data URL), or null if unreadable. */
async function readAttachment(path: string): Promise<IslandAttachment | null> {
	const mimeType = IMAGE_MIME[extname(path).toLowerCase()];
	if (!mimeType) {
		return null;
	}
	try {
		const bytes = await readFile(path);
		return {
			path,
			name: basename(path),
			mimeType,
			dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
		};
	} catch {
		// A file that vanished between pick and read is skipped, not fatal.
		return null;
	}
}

/** Register the system IPC handlers (open-external + attach images). */
export function registerSystemIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(IPC.system.openExternal, async (_event, url: unknown) => {
		if (typeof url !== "string" || !SAFE_SCHEME_RE.test(url.trim())) {
			return;
		}
		await shell.openExternal(url.trim());
	});

	ipcMain.handle(
		IPC.system.attachFiles,
		async (): Promise<IslandAttachment[]> => {
			const win = getWindow();
			const options: OpenDialogOptions = {
				properties: ["openFile", "multiSelections"],
				title: "Attach images",
				filters: [
					{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
				],
			};
			// Parent to the island window when present so the picker is modal-attached;
			// fall back to a standalone dialog if the window is gone.
			const result =
				win && !win.isDestroyed()
					? await dialog.showOpenDialog(win, options)
					: await dialog.showOpenDialog(options);
			if (result.canceled) {
				return [];
			}
			const read = await Promise.all(result.filePaths.map(readAttachment));
			return read.filter((item): item is IslandAttachment => item !== null);
		}
	);
}
