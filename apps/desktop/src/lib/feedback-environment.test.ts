import { describe, expect, test } from "bun:test";
import {
	environmentAttachments,
	errorAttachments,
	type FeedbackEnvironment,
	feedbackAttachments,
	MAX_ERROR_CHARS,
	MAX_RECENT_ERRORS,
	recentErrorTexts,
	redactFeedbackLine,
} from "./feedback-environment.ts";

const ENVIRONMENT: FeedbackEnvironment = {
	agentId: "claude-code",
	appVersion: "0.5.2",
	coreVersion: "0.5.2",
	gatewayVersion: "0.5.1",
	locale: "ar",
	model: "claude-sonnet-4-5",
	system: "windows-x86_64",
};

function failedTool(tool: string, errorText: string) {
	return { errorText, state: "output-error", type: `tool-${tool}` };
}

describe("error text redaction", () => {
	test("home folders become a tilde on every platform", () => {
		expect(
			redactFeedbackLine("ENOENT: /Users/maria/work/acme/app.ts", 300)
		).toBe("ENOENT: ~/work/acme/app.ts");
		expect(redactFeedbackLine("open /home/dev-7/.config/ryu failed", 300)).toBe(
			"open ~/.config/ryu failed"
		);
		expect(
			redactFeedbackLine(
				"can't read C:\\Users\\jiawei\\AppData\\ryu\\db.sqlite",
				300
			)
		).toBe("can't read ~\\AppData\\ryu\\db.sqlite");
		// Backslashes that arrived escaped (JSON, a debug print).
		expect(
			redactFeedbackLine('path: "C:\\\\Users\\\\jiawei\\\\ryu"', 300)
		).not.toContain("jiawei");
	});

	test("tokens and keys are removed", () => {
		const line = redactFeedbackLine(
			"401 from api: Authorization: Bearer abcdef1234567890XYZ, key sk-proj_abcdefghijklmnop1234, OPENAI_API_KEY=hunter2hunter2, ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			600
		);
		expect(line).not.toContain("abcdef1234567890XYZ");
		expect(line).not.toContain("sk-proj_abcdefghijklmnop1234");
		expect(line).not.toContain("hunter2hunter2");
		expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		expect(line).toContain("[REDACTED");
		expect(line).toContain("401 from api");
	});

	test("email addresses and credentials in URLs are removed", () => {
		const line = redactFeedbackLine(
			"push to https://maria:s3cr3t@git.example.com/acme.git rejected for maria.lopez@example.com",
			300
		);
		expect(line).not.toContain("maria.lopez@example.com");
		expect(line).not.toContain("s3cr3t");
		expect(line).toContain("[REDACTED EMAIL]");
		expect(line).toContain("git.example.com");
	});

	test("the line is one line and cut after redaction", () => {
		expect(redactFeedbackLine("first\n\n  second\tthird", 300)).toBe(
			"first second third"
		);
		const long = redactFeedbackLine(`${"x".repeat(400)} tail`, MAX_ERROR_CHARS);
		expect([...long]).toHaveLength(MAX_ERROR_CHARS);
		expect(long.endsWith("…")).toBe(true);
		// A secret that straddles the cut is redacted first, never half shown.
		const secret = `${"y".repeat(290)} maria.lopez@example.com`;
		const cut = redactFeedbackLine(secret, MAX_ERROR_CHARS);
		expect(cut).not.toContain("maria");
	});
});

describe("recent errors of a conversation", () => {
	const messages = [
		{ parts: [{ text: "my password is hunter2", type: "text" }], role: "user" },
		{
			parts: [
				failedTool("Bash", "exit code 1"),
				{
					input: { command: "cat ~/.ssh/id_rsa" },
					output: "PRIVATE",
					state: "output-available",
					type: "tool-Bash",
				},
				{
					errorText: "timed out",
					state: "output-error",
					toolName: "linear.search",
					type: "dynamic-tool",
				},
				{ message: "The model stopped responding.", type: "error" },
			],
			role: "assistant",
		},
	];

	test("reads only error text, never inputs, outputs or chat text", () => {
		expect(recentErrorTexts(messages)).toEqual([
			"Bash: exit code 1",
			"linear.search: timed out",
			"The model stopped responding.",
		]);
		const everything = recentErrorTexts(messages).join(" ");
		expect(everything).not.toContain("hunter2");
		expect(everything).not.toContain("id_rsa");
		expect(everything).not.toContain("PRIVATE");
	});

	test("keeps the last five, oldest first", () => {
		const many = [
			{
				parts: Array.from({ length: 8 }, (_, index) =>
					failedTool("Bash", `failure ${index + 1}`)
				),
			},
		];
		expect(recentErrorTexts(many)).toEqual([
			"Bash: failure 4",
			"Bash: failure 5",
			"Bash: failure 6",
			"Bash: failure 7",
			"Bash: failure 8",
		]);
		expect(recentErrorTexts(many)).toHaveLength(MAX_RECENT_ERRORS);
	});

	test("ignores malformed messages and parts", () => {
		expect(
			recentErrorTexts([
				null,
				"text",
				{ parts: "nope" },
				{ parts: [null, 3, { errorText: "  " }, { type: "error" }] },
			])
		).toEqual([]);
	});
});

describe("attachments", () => {
	test("errors are redacted, numbered and sent once each", () => {
		expect(
			errorAttachments([
				"Bash: cannot open /Users/maria/secret-project/.env",
				"Bash: cannot open /Users/maria/secret-project/.env",
				"   ",
				"Read: token=abcd1234abcd1234 refused",
			])
		).toEqual([
			{
				group: "error",
				id: "error-1",
				label: "Recent error 1",
				value: "Bash: cannot open ~/secret-project/.env",
			},
			{
				group: "error",
				id: "error-2",
				label: "Recent error 2",
				value: "Read: token=[REDACTED] refused",
			},
		]);
	});

	test("the environment lists what is known and leaves out the rest", () => {
		expect(
			environmentAttachments(ENVIRONMENT).map(
				(line) => `${line.label}: ${line.value}`
			)
		).toEqual([
			"Surface: Desktop",
			"App version: 0.5.2",
			"Core version: 0.5.2",
			"Gateway version: 0.5.1",
			"System: windows-x86_64",
			"Language: ar",
			"Agent: claude-code",
			"Model: claude-sonnet-4-5",
		]);
		expect(
			environmentAttachments({
				agentId: null,
				appVersion: "0.5.2",
				coreVersion: null,
				gatewayVersion: " ",
				locale: null,
				model: null,
				system: null,
			}).map((line) => line.id)
		).toEqual(["surface", "appVersion"]);
	});

	test("ideas carry no errors; bugs carry the recent ones", () => {
		const messages = [{ parts: [failedTool("Bash", "exit code 1")] }];
		const idea = feedbackAttachments("idea", ENVIRONMENT, messages);
		expect(idea.every((line) => line.group === "environment")).toBe(true);
		const bug = feedbackAttachments("bug", ENVIRONMENT, messages);
		expect(bug.filter((line) => line.group === "error")).toEqual([
			{
				group: "error",
				id: "error-1",
				label: "Recent error 1",
				value: "Bash: exit code 1",
			},
		]);
		// Every line has its own id, so each can be removed on the card.
		expect(new Set(bug.map((line) => line.id)).size).toBe(bug.length);
	});
});
