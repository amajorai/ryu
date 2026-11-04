import { afterEach, describe, expect, it } from "bun:test";
import {
	formatMessage,
	type LiteralMessage,
	type MessageValuesInput,
} from "@ryu/i18n";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import {
	AttachmentError,
	attachmentErrorMessage,
	attachmentNotText,
	attachmentTooLarge,
} from "./attachment-errors.ts";

const TOO_LARGE = "{name} is too large to attach (max {size}).";
const NOT_TEXT = "{name} doesn't look like a text file.";

const englishTl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

function tlFor(locale: string, table: Record<string, string>): LiteralMessage {
	return (source, values) =>
		formatMessage(table[source] ?? source, values ?? {}, locale);
}

describe("AttachmentError", () => {
	it("carries a code and the values, with no English sentence", () => {
		const tooLarge = attachmentTooLarge("notes.txt", 2 * 1024 * 1024);
		expect(tooLarge).toBeInstanceOf(AttachmentError);
		expect(tooLarge.code).toBe("too-large");
		expect(tooLarge.values).toEqual({
			name: "notes.txt",
			maxBytes: 2 * 1024 * 1024,
		});
		expect(tooLarge.message).toBe("too-large");

		const notText = attachmentNotText("data.csv");
		expect(notText.code).toBe("not-text");
		expect(notText.values).toEqual({ name: "data.csv" });
	});
});

describe("attachmentErrorMessage", () => {
	it("renders whole English sentences", () => {
		expect(
			attachmentErrorMessage(
				attachmentTooLarge("notes.txt", 2 * 1024 * 1024),
				"notes.txt",
				englishTl
			)
		).toBe("notes.txt is too large to attach (max 2 MB).");
		expect(
			attachmentErrorMessage(attachmentNotText("a.log"), "a.log", englishTl)
		).toBe("a.log doesn't look like a text file.");
	});

	it("keeps another Error's message and names an unknown failure", () => {
		expect(
			attachmentErrorMessage(new Error("upload failed"), "x.png", englishTl)
		).toBe("upload failed");
		expect(attachmentErrorMessage("boom", "x.png", englishTl)).toBe(
			"Could not read x.png"
		);
	});

	describe("in Japanese and German", () => {
		const runtime = (locale: string) => ({
			direction: "ltr" as const,
			locale,
			translate(id: string, values?: MessageValuesInput, fallback?: string) {
				return formatMessage(fallback ?? id, values, locale);
			},
		});
		const japanese = runtime("ja");
		const german = runtime("de");
		afterEach(() => {
			unregisterActiveI18nRuntime(japanese);
			unregisterActiveI18nRuntime(german);
		});

		it("renders the toast description in Japanese", () => {
			registerActiveI18nRuntime(japanese);
			const tl = tlFor("ja", {
				[TOO_LARGE]: "{name} は大きすぎて添付できません（最大 {size}）。",
				[NOT_TEXT]: "{name} はテキストファイルではないようです。",
			});
			expect(
				attachmentErrorMessage(attachmentNotText("メモ.txt"), "メモ.txt", tl)
			).toBe("メモ.txt はテキストファイルではないようです。");
			const tooLarge = attachmentErrorMessage(
				attachmentTooLarge("メモ.txt", 2 * 1024 * 1024),
				"メモ.txt",
				tl
			);
			expect(
				tooLarge.startsWith("メモ.txt は大きすぎて添付できません（最大 ")
			).toBe(true);
			expect(tooLarge).not.toContain("too large");
		});

		it("formats the size cap in the UI locale's numbers", () => {
			registerActiveI18nRuntime(german);
			const tl = tlFor("de", {
				[TOO_LARGE]: "{name} ist zu groß zum Anhängen (max. {size}).",
			});
			const message = attachmentErrorMessage(
				attachmentTooLarge("notizen.txt", 1.5 * 1024 * 1024),
				"notizen.txt",
				tl
			);
			expect(message).toContain("1,5");
			expect(message.startsWith("notizen.txt ist zu groß zum Anhängen")).toBe(
				true
			);
		});
	});
});
