import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { languagePacks } from "../services/language-packs.ts";

export function registerLanguagePacksIpc(): void {
	ipcMain.handle(IPC.languagePacks.get, () => languagePacks());
}
