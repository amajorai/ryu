import { afterEach, describe, expect, test } from "bun:test";
import {
	attachmentLine,
	clampFeedbackText,
	composeFeedbackReport,
	FEEDBACK_BODY_MAX,
	FEEDBACK_DETAIL_MAX,
	FEEDBACK_TITLE_MAX,
	type FeedbackAttachment,
	type FeedbackDraft,
	feedbackDraftFromInput,
	feedbackFollowUp,
	isFeedbackDraftPart,
	isSendableDraft,
	readFeedbackDecision,
	writeFeedbackDecision,
} from "./feedback-tool.ts";

function draft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
	return {
		actual: null,
		body: "Exports ignore the dark theme.",
		expected: null,
		kind: "idea",
		steps: null,
		title: "Dark mode for exports",
		...overrides,
	};
}

const VERSION: FeedbackAttachment = {
	group: "environment",
	id: "appVersion",
	label: "App version",
	value: "0.5.2",
};
const ERROR: FeedbackAttachment = {
	group: "error",
	id: "error-1",
	label: "Recent error 1",
	value: "Bash: exit code 1",
};

describe("feedback draft part detection", () => {
	test("matches the typed part and the dynamic-tool name only", () => {
		expect(isFeedbackDraftPart("tool-feedback.draft", undefined)).toBe(true);
		expect(isFeedbackDraftPart("dynamic-tool", "feedback.draft")).toBe(true);
		expect(isFeedbackDraftPart("dynamic-tool", "feedback.send")).toBe(false);
		expect(isFeedbackDraftPart("tool-consent.connect_app", undefined)).toBe(
			false
		);
		// A tool name only counts on a dynamic-tool part.
		expect(isFeedbackDraftPart("text", "feedback.draft")).toBe(false);
	});
});

describe("feedback draft parsing", () => {
	test("accepts both kinds and trims the text", () => {
		expect(
			feedbackDraftFromInput({
				body: "  I would like it.  ",
				kind: "idea",
				title: " Dark mode ",
			})
		).toEqual({
			actual: null,
			body: "I would like it.",
			expected: null,
			kind: "idea",
			steps: null,
			title: "Dark mode",
		});
		expect(
			feedbackDraftFromInput({
				actual: "It closed.",
				body: "The app closed.",
				expected: "",
				kind: "bug",
				steps: "Open a chat.",
				title: "Crash",
			})
		).toEqual({
			actual: "It closed.",
			body: "The app closed.",
			expected: null,
			kind: "bug",
			steps: "Open a chat.",
			title: "Crash",
		});
	});

	test("rejects what Core rejects", () => {
		const ok = { body: "y", kind: "bug", title: "x" };
		expect(feedbackDraftFromInput({ ...ok, kind: "praise" })).toBeNull();
		expect(feedbackDraftFromInput({ ...ok, title: "   " })).toBeNull();
		expect(feedbackDraftFromInput({ ...ok, body: undefined })).toBeNull();
		expect(feedbackDraftFromInput({ ...ok, steps: ["a"] })).toBeNull();
		expect(feedbackDraftFromInput(undefined)).toBeNull();
		expect(
			feedbackDraftFromInput({
				...ok,
				title: "t".repeat(FEEDBACK_TITLE_MAX + 1),
			})
		).toBeNull();
		expect(
			feedbackDraftFromInput({ ...ok, body: "b".repeat(FEEDBACK_BODY_MAX + 1) })
		).toBeNull();
		expect(
			feedbackDraftFromInput({
				...ok,
				actual: "d".repeat(FEEDBACK_DETAIL_MAX + 1),
			})
		).toBeNull();
	});

	test("counts characters like Core, not UTF-16 units", () => {
		const title = "😀".repeat(FEEDBACK_TITLE_MAX);
		expect(
			feedbackDraftFromInput({ body: "y", kind: "idea", title })?.title
		).toBe(title);
	});
});

describe("editing limits", () => {
	test("clamps to the cap without splitting an emoji", () => {
		expect(clampFeedbackText("abcdef", 4)).toBe("abcd");
		expect(clampFeedbackText("😀😀😀", 2)).toBe("😀😀");
		expect(clampFeedbackText("short", 120)).toBe("short");
	});

	test("a draft without a title or text cannot be sent", () => {
		expect(isSendableDraft(draft())).toBe(true);
		expect(isSendableDraft(draft({ title: "  " }))).toBe(false);
		expect(isSendableDraft(draft({ body: "" }))).toBe(false);
	});
});

describe("report text", () => {
	test("an idea carries the title, the text and the attached lines", () => {
		expect(composeFeedbackReport(draft(), [VERSION])).toBe(
			[
				"[Idea] Dark mode for exports",
				"Exports ignore the dark theme.",
				"Attached by the Ryu app:\nApp version: 0.5.2",
				"Drafted by an agent in Ryu. The user read and approved it before sending.",
			].join("\n\n")
		);
	});

	test("a bug adds its details in order and skips blank ones", () => {
		const report = composeFeedbackReport(
			draft({
				actual: "It closed.",
				expected: "  ",
				kind: "bug",
				steps: "Open a chat.",
				title: "Crash",
			}),
			[VERSION, ERROR]
		);
		expect(report).toContain("[Bug] Crash");
		expect(report).toContain("Steps to reproduce:\nOpen a chat.");
		expect(report).toContain("What happened:\nIt closed.");
		expect(report).not.toContain("Expected:");
		expect(report.indexOf("Steps to reproduce")).toBeLessThan(
			report.indexOf("What happened")
		);
		expect(report).toContain(
			"App version: 0.5.2\nRecent error 1: Bash: exit code 1"
		);
	});

	test("nothing attached means no attachment section at all", () => {
		expect(composeFeedbackReport(draft(), [])).not.toContain("Attached by");
	});

	test("an attachment reads the same on the card and in the report", () => {
		expect(attachmentLine(ERROR)).toBe("Recent error 1: Bash: exit code 1");
	});
});

describe("follow-up to the agent", () => {
	test("uses fixed wording that never repeats the draft", () => {
		expect(feedbackFollowUp("bug", "copied")).toBe(
			"I copied the bug report and opened the feedback board to post it myself. No need to draft it again."
		);
		expect(feedbackFollowUp("idea", "declined")).toBe(
			"Not now. I don't want to send this idea."
		);
	});
});

describe("remembered decision", () => {
	const store = new Map<string, string>();
	const original = Reflect.get(globalThis, "localStorage");
	const install = (storage: unknown) =>
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		});

	afterEach(() => {
		store.clear();
		install(original);
	});

	const memoryStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
	};

	test("survives a reload, keyed by the tool call", () => {
		install(memoryStorage);
		expect(readFeedbackDecision("call-1")).toBeNull();
		writeFeedbackDecision("call-1", { kind: "copied", title: "Crash" });
		writeFeedbackDecision("call-2", { kind: "declined" });
		expect(readFeedbackDecision("call-1")).toEqual({
			kind: "copied",
			title: "Crash",
		});
		expect(readFeedbackDecision("call-2")).toEqual({ kind: "declined" });
		expect(readFeedbackDecision("call-3")).toBeNull();
		// Only the outcome and the approved title are kept, never the report.
		expect([...store.values()].join("")).not.toContain("App version");
	});

	test("ignores a missing id, corrupt records and failing storage", () => {
		install(memoryStorage);
		writeFeedbackDecision(undefined, { kind: "declined" });
		expect(store.size).toBe(0);
		store.set("ryu.feedback-decision:bad", "{not json");
		store.set("ryu.feedback-decision:odd", JSON.stringify({ kind: "sent" }));
		expect(readFeedbackDecision("bad")).toBeNull();
		expect(readFeedbackDecision("odd")).toBeNull();
		install({
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		});
		expect(readFeedbackDecision("call-1")).toBeNull();
		expect(() =>
			writeFeedbackDecision("call-1", { kind: "declined" })
		).not.toThrow();
	});
});
