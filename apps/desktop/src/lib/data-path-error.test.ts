import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	DataPathRefusal,
	dataPathActionErrorText,
	dataPathErrorText,
	dataPathValidationText,
} from "./data-path-error.ts";

// A stand-in translator that marks the sentence and fills its placeholders.
const tl = ((source: string, values?: Record<string, unknown>) =>
	`«${source.replace(/\{(\w+)\}/g, (_, name: string) =>
		String(values?.[name] ?? `{${name}}`)
	)}»`) as LiteralMessage;

const GIB = 1024 ** 3;

describe("data-path refusals", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("words a non-empty target instead of Core's English reason", () => {
		expect(
			dataPathValidationText(
				{ error: "Target folder is not empty.", reason_code: "not_empty" },
				tl
			)
		).toBe("«This folder isn't empty. Pick an empty or new folder.»");
	});

	it("formats the free-space sizes in the reader's locale", () => {
		const validation = {
			error: "Not enough free space: need 3.2 GB, have 1.1 GB.",
			reason_code: "insufficient_space",
			reason_values: { need_bytes: 3.5 * GIB, free_bytes: 1.25 * GIB },
		};
		const german = dataPathValidationText(validation, tl, "de");
		expect(german).toContain("3,5");
		expect(german).toContain("1,3");
		expect(german).not.toContain("3.5");
		// Arabic keeps its own unit name; Japanese keeps the period decimal.
		const arabic = dataPathValidationText(validation, tl, "ar");
		expect(arabic).not.toContain("GB");
		expect(arabic).toContain("غ.ب");
		expect(dataPathValidationText(validation, tl, "ja")).toContain("3.5");
		expect(dataPathValidationText(validation, tl, "en")).toBe(
			"«Not enough free space: 3.5 GB needed, 1.3 GB available.»"
		);
	});

	it("never shows an uncoded English reason", () => {
		expect(dataPathValidationText({ error: "Target path is weird." }, tl)).toBe(
			"«This folder can't be used as the data folder.»"
		);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("words a coded export refusal from an HTTP error body", () => {
		const httpError = Object.assign(new Error("failed: 400"), {
			body: {
				ok: false,
				error: "the backup passphrase must be at least 12 characters",
				code: "passphrase_too_short",
				values: { min_chars: 12 },
			},
		});
		expect(dataPathErrorText(httpError, tl, "«fallback»")).toBe(
			"«The backup passphrase must be at least 12 characters.»"
		);
		expect(
			dataPathErrorText(
				new DataPathRefusal({ ok: false, code: "export_shared_node" }),
				tl,
				"«fallback»"
			)
		).toContain("shared node");
	});

	it("uses the caller's sentence for generic or uncoded failures", () => {
		expect(
			dataPathErrorText(
				new DataPathRefusal({
					ok: false,
					error: "disk full",
					code: "export_failed",
				}),
				tl,
				"«Ryu couldn't create the backup.»"
			)
		).toBe("«Ryu couldn't create the backup.»");
		expect(
			dataPathErrorText(new Error("switch failed"), tl, "«fallback»")
		).toBe("«fallback»");
		expect(dataPathErrorText("raw", tl, "«fallback»")).toBe("«fallback»");
	});

	it("names the HTTP status of an uncoded refusal in a whole sentence", () => {
		const refused = Object.assign(
			new Error("/api/data-path/switch failed: 503"),
			{
				status: 503,
				body: { error: "Owned storage peer refused" },
			}
		);
		expect(dataPathActionErrorText("switch", refused, tl)).toBe(
			"«Ryu couldn't switch the data folder (error 503).»"
		);
		expect(dataPathActionErrorText("reset", new Error("x"), tl)).toBe(
			"«Ryu couldn't reset the data folder.»"
		);
		expect(
			dataPathActionErrorText(
				"export",
				Object.assign(new Error("failed: 400"), {
					status: 400,
					body: { code: "export_inside_data_folder" },
				}),
				tl
			)
		).toBe("«Save the backup outside the data folder.»");
	});
});
