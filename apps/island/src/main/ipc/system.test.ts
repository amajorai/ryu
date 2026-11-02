import { beforeEach, describe, expect, mock, test } from "bun:test";
import { IPC } from "../../shared/ipc.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

interface DialogOptions {
	filters?: { extensions: string[]; name: string }[];
	title?: string;
}

const handlers = new Map<string, Handler>();
const shownDialogs: DialogOptions[] = [];

mock.module("electron", () => ({
	dialog: {
		showOpenDialog: (...args: unknown[]) => {
			shownDialogs.push(args.at(-1) as DialogOptions);
			return Promise.resolve({ canceled: true, filePaths: [] });
		},
	},
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			handlers.set(channel, handler),
	},
	shell: { openExternal: () => Promise.resolve() },
}));

const { registerSystemIpc } = await import("./system.ts");

async function attach(...args: unknown[]): Promise<DialogOptions> {
	const handler = handlers.get(IPC.system.attachFiles);
	if (!handler) {
		throw new Error("attachFiles was not registered");
	}
	const picked = await handler({}, ...args);
	if (!Array.isArray(picked) || picked.length > 0) {
		throw new Error("a cancelled picker must attach nothing");
	}
	const shown = shownDialogs.at(-1);
	if (!shown) {
		throw new Error("no dialog was shown");
	}
	return shown;
}

describe("system:attachFiles IPC", () => {
	beforeEach(() => {
		handlers.clear();
		shownDialogs.length = 0;
		registerSystemIpc(() => null);
	});

	test("shows the translated title and filter name the renderer sends", async () => {
		const shown = await attach({ title: "画像を添付", filterName: "画像" });
		expect(shown.title).toBe("画像を添付");
		expect(shown.filters?.[0]?.name).toBe("画像");
		expect(shown.filters?.[0]?.extensions).toContain("png");
	});

	test("an older renderer that sends no labels still gets English", async () => {
		const shown = await attach();
		expect(shown.title).toBe("Attach images");
		expect(shown.filters?.[0]?.name).toBe("Images");
	});

	test("malformed labels fall back field by field", async () => {
		for (const labels of [
			null,
			"画像",
			42,
			{ title: "", filterName: 7 },
			{ title: "x".repeat(201), filterName: "   " },
		]) {
			const shown = await attach(labels);
			expect(shown.title).toBe("Attach images");
			expect(shown.filters?.[0]?.name).toBe("Images");
		}
		const partial = await attach({ title: "Bilder anhängen" });
		expect(partial.title).toBe("Bilder anhängen");
		expect(partial.filters?.[0]?.name).toBe("Images");
	});
});
