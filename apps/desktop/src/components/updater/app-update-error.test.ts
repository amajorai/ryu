import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	appUpdateErrorSentence,
	updateErrorSentence,
} from "./app-update-error.ts";

// A stand-in translator that marks every sentence it worded.
const tl = ((source: string, values?: Record<string, string>) => {
	let text = source;
	for (const [name, value] of Object.entries(values ?? {})) {
		text = text.replace(`{${name}}`, value);
	}
	return `«${text}»`;
}) as LiteralMessage;

const FALLBACK = "«Ryu couldn't install the update. Try again.»";

describe("updateErrorSentence", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("never passes an unknown English native string through", () => {
		const raw =
			"The managed runtime is still running; the app update was not started";
		expect(updateErrorSentence(raw, tl, FALLBACK)).toBe(FALLBACK);
		expect(updateErrorSentence(new Error(raw), tl, FALLBACK)).toBe(FALLBACK);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("words a coded rejection through the translator and logs its detail", () => {
		expect(
			updateErrorSentence(
				{ code: "runtime_still_running", detail: "port 7980 busy" },
				tl,
				FALLBACK
			)
		).toBe(
			"«The local runtime is still running, so the update was not started. Try again in a moment.»"
		);
		expect(String(warn.mock.calls[0]?.[0])).toContain("port 7980 busy");
	});

	it("fills a coded sentence's values", () => {
		expect(
			updateErrorSentence(
				{ code: "feed_moved", values: { expected: "1.2.0", offered: "1.3.0" } },
				tl,
				FALLBACK
			)
		).toBe(
			"«The update changed from v1.2.0 to v1.3.0. Check for updates again before downloading.»"
		);
	});

	it("falls back for an unknown code or an empty rejection", () => {
		expect(updateErrorSentence({ code: "from_the_future" }, tl, FALLBACK)).toBe(
			FALLBACK
		);
		expect(updateErrorSentence(undefined, tl, FALLBACK)).toBe(FALLBACK);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("appUpdateErrorSentence", () => {
	it("words every code the native layer can send", () => {
		const rust = readFileSync(
			new URL("../../../src-tauri/src/update_error.rs", import.meta.url),
			"utf8"
		);
		const wireNames = [...rust.matchAll(/\(\w+, "([a-z_]+)"\)/g)].map(
			(match) => match[1] ?? ""
		);
		expect(wireNames.length).toBeGreaterThanOrEqual(15);
		for (const code of wireNames) {
			expect(appUpdateErrorSentence({ code }, tl)).toStartWith("«");
		}
	});
});
