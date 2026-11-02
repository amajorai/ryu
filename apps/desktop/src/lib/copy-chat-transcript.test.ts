import { afterEach, describe, expect, it } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import {
	formatChatTranscript,
	formatChatTranscriptAsMarkdown,
} from "./copy-chat-transcript.ts";

function runtimeFor(locale: string, messages: Record<string, string> = {}) {
	return {
		direction: "ltr" as const,
		locale,
		translate(source: string, values?: MessageValuesInput, fallback?: string) {
			const message = (fallback && messages[fallback]) ?? fallback ?? source;
			return formatMessage(message, values, locale);
		},
	};
}

let mounted: ReturnType<typeof runtimeFor> | null = null;

afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(mounted);
		mounted = null;
	}
});

describe("formatChatTranscript", () => {
	it("joins user and assistant text turns", () => {
		const text = formatChatTranscript([
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		]);
		expect(text).toBe("User:\nHello\n\nAssistant:\nHi there");
	});

	it("prefers text parts over content", () => {
		const text = formatChatTranscript([
			{
				role: "assistant",
				content: "fallback",
				parts: [
					{ type: "text", text: "from parts" },
					{ type: "tool-invocation", toolName: "search" },
				],
			},
		]);
		expect(text).toBe("Assistant:\nfrom parts");
	});

	it("skips empty and non-chat roles", () => {
		const text = formatChatTranscript([
			{ role: "system", content: "ignore me" },
			{ role: "user", content: "   " },
			{ role: "assistant", content: "ok" },
		]);
		expect(text).toBe("Assistant:\nok");
	});

	it("includes author name for user messages", () => {
		const text = formatChatTranscript([
			{
				role: "user",
				content: "Hello",
				metadata: { author: { name: "jiawei" } },
			},
			{ role: "assistant", content: "Hi there" },
		]);
		expect(text).toBe("jiawei:\nHello\n\nAssistant:\nHi there");
	});

	it("includes timestamp when createdAt is provided", () => {
		const text = formatChatTranscript([
			{
				role: "user",
				content: "Hello",
				createdAt: new Date("2026-07-27T12:33:00"),
				metadata: { author: { name: "jiawei" } },
			},
		]);
		// ICU builds differ on the space before "PM" (U+0020 or U+202F).
		expect(text.replace(/\s(?=PM)/u, " ")).toBe(
			"jiawei, [Jul 27, 2026, 12:33 PM]:\nHello"
		);
	});

	it("falls back to author id when name is not available", () => {
		const text = formatChatTranscript([
			{
				role: "user",
				content: "Hello",
				metadata: { author: { id: "user123" } },
			},
		]);
		expect(text).toBe("user123:\nHello");
	});

	it("uses defaultUserName when no author metadata", () => {
		const text = formatChatTranscript([{ role: "user", content: "Hello" }], {
			defaultUserName: "jiawei",
		});
		expect(text).toBe("jiawei:\nHello");
	});
});

describe("formatChatTranscriptAsMarkdown", () => {
	it("adds the chat title and role headings", () => {
		const text = formatChatTranscriptAsMarkdown(
			[
				{ role: "user", content: "**Keep** this formatting." },
				{ role: "assistant", content: "Done." },
			],
			{ title: "Release notes" }
		);
		expect(text).toBe(
			"# Release notes\n\n## User\n\n**Keep** this formatting.\n\n## Assistant\n\nDone."
		);
	});

	it("flattens untrusted heading text without changing message Markdown", () => {
		const text = formatChatTranscriptAsMarkdown(
			[
				{
					role: "user",
					content: "- one\n- two",
					metadata: { author: { name: "Line one\nLine two" } },
				},
			],
			{ title: "Title\ncontinued" }
		);
		expect(text).toBe(
			"# Title continued\n\n## Line one Line two\n\n- one\n- two"
		);
	});

	it("returns an empty string when no title or chat turns exist", () => {
		expect(
			formatChatTranscriptAsMarkdown([{ role: "system", content: "ignore" }])
		).toBe("");
	});
});

describe("transcripts follow the UI language", () => {
	it("translates role labels and formats the timestamp in German", () => {
		mounted = runtimeFor("de", { Assistant: "Assistent", User: "Benutzer" });
		registerActiveI18nRuntime(mounted);
		const createdAt = new Date("2026-07-27T12:33:00");
		const text = formatChatTranscript([
			{ role: "user", content: "Hallo", createdAt },
			{ role: "assistant", content: "Hi", createdAt },
		]);
		expect(text).toBe(
			"Benutzer, [27.07.2026, 12:33]:\nHallo\n\nAssistent, [27.07.2026, 12:33]:\nHi"
		);
		expect(
			formatChatTranscriptAsMarkdown([{ role: "assistant", content: "Ja" }])
		).toBe("## Assistent\n\nJa");
	});
});
