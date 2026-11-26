import { describe, expect, test } from "bun:test";
import { GROK_BOT_MIGRATOR_PROMPT } from "./grok-bot-migrator.ts";

// What Core's archive reader accepts (`apps/core/src/import/bot_archive/`).
// Core's own test reads the prompt for the same names.
const ENTRY_PATHS = [
	"ryu-export.json",
	"bots/<key>/instructions.md",
	"bots/<key>/memories.md",
	"bots/<key>/skills/<skill-name>/SKILL.md",
	"bots/<key>/files/",
	"bots/<key>/conversations/<name>.json",
];

describe("the Grok Bot migrator prompt", () => {
	test("names every entry Core's archive reader accepts", () => {
		for (const path of ENTRY_PATHS) {
			expect(GROK_BOT_MIGRATOR_PROMPT).toContain(path);
		}
	});

	test("shows a manifest Core reads as this format and version", () => {
		const start = GROK_BOT_MIGRATOR_PROMPT.indexOf('{\n  "format"');
		const end = GROK_BOT_MIGRATOR_PROMPT.indexOf("\n}\n", start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const manifest = JSON.parse(GROK_BOT_MIGRATOR_PROMPT.slice(start, end + 2));
		expect(manifest.format).toBe("ryu-bot-export");
		expect(manifest.version).toBe(1);
		expect(Object.keys(manifest.bots[0])).toEqual([
			"key",
			"name",
			"description",
			"routines",
			"not_exported",
		]);
	});

	test("shows a conversation Core reads", () => {
		const line = GROK_BOT_MIGRATOR_PROMPT.split("\n").find((candidate) =>
			candidate.startsWith('{ "title"')
		);
		const conversation = JSON.parse(line ?? "null");
		expect(
			conversation.messages.map((message: { role: string }) => message.role)
		).toEqual(["user", "assistant"]);
	});

	test("asks before packing and forbids secrets and guesses", () => {
		expect(GROK_BOT_MIGRATOR_PROMPT).toContain("wait for my answer");
		expect(GROK_BOT_MIGRATOR_PROMPT).toContain("Never pack passwords");
		expect(GROK_BOT_MIGRATOR_PROMPT).toContain("do not guess");
		expect(GROK_BOT_MIGRATOR_PROMPT).not.toContain(
			String.fromCharCode(0x20_14)
		);
	});
});
