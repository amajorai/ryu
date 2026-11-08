// Serves the OS's preferred languages to the Island renderer, so its automatic
// UI language walks the same list the main process uses for the Ghost cursor
// label and proactive suggestions (`suggestion-locale.ts`,
// `ghost-cursor-locale.ts`) instead of Chromium's accept-language list.

import { app, ipcMain } from "electron";
import { SYSTEM_LANGUAGES_CHANNEL } from "../shared/system-languages-channel.ts";

/** The full OS language list, else the app locale; empty when unreadable. */
export function electronSystemLanguages(): string[] {
	try {
		const preferred = app.getPreferredSystemLanguages();
		return preferred.length > 0 ? preferred : [app.getLocale()];
	} catch {
		return [];
	}
}

/** Register the read; `read` is injected so the handler stays testable. */
export function registerSystemLanguagesIpc(
	read: () => string[] = electronSystemLanguages
): void {
	ipcMain.handle(SYSTEM_LANGUAGES_CHANNEL, () => read());
}
