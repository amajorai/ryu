import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SYSTEM_LANGUAGES_CHANNEL } from "../shared/system-languages-channel.ts";

const handlers = new Map<string, () => unknown>();
let preferred: string[] | Error = [];

mock.module("electron", () => ({
	app: {
		getPreferredSystemLanguages: () => {
			if (preferred instanceof Error) {
				throw preferred;
			}
			return preferred;
		},
		getLocale: () => "en-GB",
	},
	ipcMain: {
		handle: (channel: string, handler: () => unknown) =>
			handlers.set(channel, handler),
	},
}));

const { electronSystemLanguages, registerSystemLanguagesIpc } = await import(
	"./system-languages-ipc.ts"
);

describe("system languages IPC", () => {
	beforeEach(() => {
		handlers.clear();
		preferred = [];
	});

	test("answers the full OS list, not only its first entry", () => {
		preferred = ["nl-NL", "de-DE"];
		registerSystemLanguagesIpc();
		expect(handlers.get(SYSTEM_LANGUAGES_CHANNEL)?.()).toEqual([
			"nl-NL",
			"de-DE",
		]);
	});

	test("falls back to the app locale, then to an empty list", () => {
		expect(electronSystemLanguages()).toEqual(["en-GB"]);
		preferred = new Error("unavailable");
		expect(electronSystemLanguages()).toEqual([]);
	});
});
