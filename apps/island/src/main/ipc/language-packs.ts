import { type BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { parseSelectedPackId } from "../../shared/language-selection.ts";
import { LANGUAGE_SELECTION_CHANNEL } from "../../shared/language-selection-channel.ts";
import {
	languagePacks,
	selectLanguagePack,
} from "../services/language-packs.ts";

export function registerLanguagePacksIpc(
	getWindow: () => BrowserWindow | null
): void {
	ipcMain.handle(IPC.languagePacks.get, () => languagePacks());
	ipcMain.handle(LANGUAGE_SELECTION_CHANNEL, (event, value: unknown) => {
		// Only the Island renderer has a picker. The screen-surface window renders
		// agent-authored UI and must never change the user's language.
		if (event.sender !== getWindow()?.webContents) {
			return false;
		}
		const packId = parseSelectedPackId(value);
		return packId === undefined ? false : selectLanguagePack(packId);
	});
}
