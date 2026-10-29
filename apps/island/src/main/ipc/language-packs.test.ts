import { beforeEach, describe, expect, mock, test } from "bun:test";
import { LANGUAGE_SELECTION_CHANNEL } from "../../shared/language-selection-channel.ts";

type Handler = (event: { sender: unknown }, value: unknown) => unknown;

const handlers = new Map<string, Handler>();
const selected: Array<string | null> = [];

mock.module("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			handlers.set(channel, handler),
	},
}));
mock.module("../services/language-packs.ts", () => ({
	languagePacks: () => Promise.resolve({ available: true, packs: [] }),
	selectLanguagePack: (packId: string | null) => {
		selected.push(packId);
		return Promise.resolve(true);
	},
}));

const { registerLanguagePacksIpc } = await import("./language-packs.ts");

const islandContents = { id: "island" };
const surfaceContents = { id: "screen-surface" };

function select(sender: unknown, value: unknown): unknown {
	const handler = handlers.get(LANGUAGE_SELECTION_CHANNEL);
	if (!handler) {
		throw new Error("language selection channel was not registered");
	}
	return handler({ sender }, value);
}

describe("language-packs:select IPC", () => {
	beforeEach(() => {
		handlers.clear();
		selected.length = 0;
		registerLanguagePacksIpc(() => ({ webContents: islandContents }) as never);
	});

	test("saves a valid choice from the Island window", async () => {
		expect(await select(islandContents, "official/fr")).toBe(true);
		expect(await select(islandContents, null)).toBe(true);
		expect(selected).toEqual(["official/fr", null]);
	});

	test("rejects the screen-surface window and unknown senders", async () => {
		expect(await select(surfaceContents, "official/fr")).toBe(false);
		expect(await select({}, null)).toBe(false);
		expect(selected).toEqual([]);
	});

	test("rejects malformed pack ids before they reach the service", async () => {
		for (const value of [42, "", "x".repeat(129), { id: "fr" }, undefined]) {
			expect(await select(islandContents, value)).toBe(false);
		}
		expect(selected).toEqual([]);
	});

	test("rejects every sender while no Island window exists", async () => {
		handlers.clear();
		registerLanguagePacksIpc(() => null);
		expect(await select(islandContents, "official/fr")).toBe(false);
		expect(selected).toEqual([]);
	});
});
