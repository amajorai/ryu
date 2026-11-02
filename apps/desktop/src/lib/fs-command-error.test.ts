import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	fileTreeModelErrorText,
	fsCommandErrorMessage,
	fsCommandErrorSentence,
	fsCommandErrorText,
	workspaceItemOpenErrorToast,
} from "./fs-command-error.ts";

// A stand-in translator that marks every sentence it worded.
const tl = ((source: string) => `«${source}»`) as LiteralMessage;

const FALLBACK = "«Ryu couldn't move that item.»";

describe("fsCommandErrorText", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("never passes raw English native or OS text through", () => {
		const raw =
			"Workspace move refused (destination must be empty and atomic exclusive rename supported): File exists (os error 17)";
		expect(fsCommandErrorText(raw, tl, FALLBACK)).toBe(FALLBACK);
		expect(fsCommandErrorText(new Error(raw), tl, FALLBACK)).toBe(FALLBACK);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("words a coded rejection and logs only its detail", () => {
		expect(
			fsCommandErrorText(
				{ code: "destination_exists", detail: "File exists (os error 17)" },
				tl,
				FALLBACK
			)
		).toBe("«An item with that name already exists here.»");
		expect(warn).toHaveBeenCalledWith(
			"[fs-command] destination_exists: File exists (os error 17)"
		);
	});

	it("uses the caller's sentence for a generic or unknown code", () => {
		const restore = "«Ryu couldn't restore that backup.»";
		expect(
			fsCommandErrorText(
				{ code: "data_command_failed", detail: "disk full" },
				tl,
				restore
			)
		).toBe(restore);
		expect(
			fsCommandErrorMessage({ code: "from_the_future" }, tl, restore)
		).toBe(restore);
	});

	it("words every code the native layer can send", () => {
		const rust = readFileSync(
			new URL("../../src-tauri/src/fs_command_error.rs", import.meta.url),
			"utf8"
		);
		const wireNames = [...rust.matchAll(/\(\w+, "([a-z_]+)"\)/g)].map(
			(match) => match[1] ?? ""
		);
		expect(wireNames.length).toBe(19);
		for (const code of wireNames) {
			const sentence = fsCommandErrorSentence({ code }, tl);
			if (code === "data_command_failed") {
				expect(sentence).toBeNull();
			} else {
				expect(sentence).toStartWith("«");
			}
		}
	});
});

describe("workspaceItemOpenErrorToast", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("translates a vanished item instead of showing the OS errno text", () => {
		const toast = workspaceItemOpenErrorToast(
			{
				code: "item_unavailable",
				detail: "No such file or directory (os error 2)",
			},
			tl
		);
		expect(toast).toEqual({
			description: "«That item no longer exists. Refresh the file list.»",
			title: "«Couldn't open that workspace item»",
		});
		expect(JSON.stringify(toast)).not.toContain("os error");
		expect(warn).toHaveBeenCalledWith(
			"[fs-command] item_unavailable: No such file or directory (os error 2)"
		);
	});

	it("words launch failures and drops uncoded English text", () => {
		expect(
			workspaceItemOpenErrorToast(
				{ code: "launch_failed", detail: "program not found" },
				tl
			).description
		).toBe("«Ryu couldn't start the app to open that item.»");
		expect(
			workspaceItemOpenErrorToast("Workspace item not found: gone", tl)
		).toEqual({ title: "«Couldn't open that workspace item»" });
	});
});

describe("fileTreeModelErrorText", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("maps the @pierre/trees collision messages to one sentence", () => {
		for (const message of [
			'Destination already exists: "src/alpha.ts"',
			'"src/alpha.ts" already exists.',
		]) {
			expect(fileTreeModelErrorText(message, tl, FALLBACK)).toBe(
				"«An item with that name already exists here.»"
			);
		}
	});

	it("replaces any other library message with the fallback", () => {
		expect(fileTreeModelErrorText("Unknown drop target", tl, FALLBACK)).toBe(
			FALLBACK
		);
		expect(warn).toHaveBeenCalledWith(
			"[file-tree] model refused:",
			"Unknown drop target"
		);
	});
});
