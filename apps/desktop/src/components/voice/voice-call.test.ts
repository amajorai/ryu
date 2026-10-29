import { describe, expect, test } from "bun:test";
import {
	finishedCallRows,
	foldFinishedCall,
	formatVoiceCallDuration,
	getVoiceCallInitials,
} from "./voice-call.ts";

describe("voice call display helpers", () => {
	test("formats elapsed time as a stable call timer", () => {
		expect(formatVoiceCallDuration(0)).toBe("00:00");
		expect(formatVoiceCallDuration(83)).toBe("01:23");
		expect(formatVoiceCallDuration(Number.NaN)).toBe("00:00");
	});

	test("creates compact initials for the call avatar", () => {
		expect(getVoiceCallInitials("Ryu")).toBe("RY");
		expect(getVoiceCallInitials("Ryu Assistant")).toBe("RA");
		expect(getVoiceCallInitials("  ")).toBe("R");
	});
});

const row = (id: string, role: string, content: string) => ({
	content,
	id,
	role,
});

describe("finished call history", () => {
	const stored = [
		row("old-user", "user", "Earlier question"),
		row("old-reply", "assistant", "Earlier answer"),
		row("old-summary", "user", "Call ended · 00:12"),
		row("voice-user", "user", "What is on my calendar?"),
		row("voice-reply", "assistant", "Two meetings."),
		row("summary", "user", "Call ended · 01:24"),
	];

	test("takes only the rows of the call that just ended", () => {
		expect(
			finishedCallRows(stored, new Set(["summary"]), "summary").map(
				(entry) => entry.id
			)
		).toEqual(["voice-user", "voice-reply"]);
	});

	test("stops at rows that are already on screen", () => {
		expect(
			finishedCallRows(stored, new Set(["voice-user", "summary"]), "summary")
		).toEqual([row("voice-reply", "assistant", "Two meetings.")]);
	});

	test("adds nothing when the summary is not stored", () => {
		expect(finishedCallRows(stored, new Set(), "missing")).toEqual([]);
	});

	test("folds the call's turns in ahead of its summary", () => {
		const current = [
			{ id: "builder-1", text: "Make it blue" },
			{ id: "summary", text: "Call ended · 01:24" },
		];
		const folded = foldFinishedCall(current, stored, "summary", (entry) => ({
			id: entry.id,
			text: entry.content,
		}));
		expect(folded.map((message) => message.id)).toEqual([
			"builder-1",
			"voice-user",
			"voice-reply",
			"summary",
		]);
	});

	test("keeps the transcript identity when nothing is missing", () => {
		const current = [
			{ id: "voice-user" },
			{ id: "voice-reply" },
			{ id: "summary" },
		];
		expect(
			foldFinishedCall(current, stored, "summary", (entry) => ({
				id: entry.id,
			}))
		).toBe(current);
	});
});
