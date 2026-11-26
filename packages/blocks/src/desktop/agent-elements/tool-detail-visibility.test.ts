import { describe, expect, it } from "bun:test";
import {
	hasVisibleContentAtNoDetail,
	isFailedToolPart,
	isHiddenAtNoDetail,
	isToolLikePart,
} from "./tool-detail-visibility.ts";

describe("isToolLikePart", () => {
	it("matches v5 tool parts, dynamic tools and widget parts", () => {
		expect(isToolLikePart({ type: "tool-Edit" })).toBe(true);
		expect(
			isToolLikePart({ type: "dynamic-tool", toolName: "web_fetch" })
		).toBe(true);
		expect(isToolLikePart({ type: "data-tool-widget-available" })).toBe(true);
	});

	it("does not match text, errors or bookkeeping parts", () => {
		expect(isToolLikePart({ type: "text", text: "hi" })).toBe(false);
		expect(isToolLikePart({ type: "error", message: "boom" })).toBe(false);
		expect(isToolLikePart({ type: "step-start" })).toBe(false);
		expect(isToolLikePart(null)).toBe(false);
		expect(isToolLikePart("tool-Edit")).toBe(false);
	});
});

describe("isFailedToolPart", () => {
	it("reads the v5 error state", () => {
		expect(isFailedToolPart({ type: "tool-Bash", state: "output-error" })).toBe(
			true
		);
	});

	it("reads a non-empty errorText even without the state", () => {
		expect(isFailedToolPart({ type: "tool-Bash", errorText: "exit 1" })).toBe(
			true
		);
		expect(isFailedToolPart({ type: "tool-Bash", errorText: "  " })).toBe(
			false
		);
	});

	it("is false for a succeeded tool and for non-tool parts", () => {
		expect(
			isFailedToolPart({ type: "tool-Bash", state: "output-available" })
		).toBe(false);
		expect(isFailedToolPart({ type: "error", message: "boom" })).toBe(false);
	});
});

describe("isHiddenAtNoDetail", () => {
	it("hides every succeeded tool row", () => {
		expect(isHiddenAtNoDetail({ type: "tool-Edit" })).toBe(true);
		expect(isHiddenAtNoDetail({ type: "tool-Write" })).toBe(true);
		expect(isHiddenAtNoDetail({ type: "dynamic-tool", toolName: "grep" })).toBe(
			true
		);
	});

	it("keeps cards that ask the user something", () => {
		// The agent ended its turn to wait for the answer, so the card must not
		// vanish with the rest of the tool detail.
		expect(isHiddenAtNoDetail({ type: "tool-feedback.draft" })).toBe(false);
		expect(
			isHiddenAtNoDetail({ type: "dynamic-tool", toolName: "feedback.draft" })
		).toBe(false);
		expect(isHiddenAtNoDetail({ type: "tool-consent.connect_app" })).toBe(
			false
		);
		// Only the exact tool counts.
		expect(
			isHiddenAtNoDetail({ type: "dynamic-tool", toolName: "feedback.send" })
		).toBe(true);
	});

	it("hides thinking/reasoning traces, which arrive as tool parts", () => {
		expect(isHiddenAtNoDetail({ type: "tool-Thinking" })).toBe(true);
		expect(
			isHiddenAtNoDetail({ type: "dynamic-tool", toolName: "reasoning" })
		).toBe(true);
	});

	it("hides the app widget minted for a tool call", () => {
		expect(
			isHiddenAtNoDetail({
				type: "data-tool-widget-available",
				data: { toolCallId: "abc" },
			})
		).toBe(true);
	});

	it("keeps a failed tool row — a silent failed turn is the worst outcome", () => {
		expect(
			isHiddenAtNoDetail({ type: "tool-Bash", state: "output-error" })
		).toBe(false);
	});

	it("hides tool-TaskOutput even when it failed, as the render loop does", () => {
		expect(
			isHiddenAtNoDetail({ type: "tool-TaskOutput", state: "output-error" })
		).toBe(true);
	});

	it("never hides a non-tool part", () => {
		expect(isHiddenAtNoDetail({ type: "text", text: "hi" })).toBe(false);
		expect(isHiddenAtNoDetail({ type: "error", message: "boom" })).toBe(false);
	});
});

describe("hasVisibleContentAtNoDetail", () => {
	it("is false for a turn made only of succeeded tool calls", () => {
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "step-start" },
				{ type: "tool-Read", state: "output-available" },
				{ type: "tool-Edit", state: "output-available" },
			])
		).toBe(false);
	});

	it("keeps a completed end-of-turn result card visible", () => {
		expect(
			hasVisibleContentAtNoDetail([
				{
					input: {
						file_path: "src/result.ts",
						new_string: "ready",
						old_string: "draft",
					},
					type: "tool-Edit",
				},
				{
					input: {
						placement: "turn-end",
						spec: {
							elements: {},
							root: "result",
						},
					},
					type: "tool-ui.render",
				},
			])
		).toBe(true);
	});

	it("is false for a turn whose only text is empty", () => {
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "text", text: "   " },
				{ type: "tool-Read" },
			])
		).toBe(false);
	});

	it("is true when the turn has assistant prose", () => {
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "tool-Read" },
				{ type: "text", text: "Done." },
			])
		).toBe(true);
	});

	it("is true when a tool call failed", () => {
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "tool-Bash", state: "output-error", errorText: "exit 1" },
			])
		).toBe(true);
	});

	it("is true for a turn-level error part", () => {
		expect(
			hasVisibleContentAtNoDetail([{ type: "error", message: "stream failed" }])
		).toBe(true);
	});

	it("does not see the interrupted flag — that is the caller's job", () => {
		// `_interrupted` is stamped on the MESSAGE, never into `parts`, so an
		// interrupted turn of pure tool work reads as no-content HERE and is kept
		// alive by `isInterruptedMessage` in message-list.tsx instead. Asserted so
		// that moving the flag into `parts` fails loudly rather than quietly
		// double-counting.
		expect(hasVisibleContentAtNoDetail([{ type: "tool-Bash" }])).toBe(false);
	});

	it("is true for images, generated images and attachments", () => {
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "file", mediaType: "image/png", url: "data:image/png;base64," },
			])
		).toBe(true);
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "data-image-generation", data: { status: "generating" } },
			])
		).toBe(true);
		// The video twin. Asserted alongside its image counterpart rather than in a
		// case of its own, because the failure this catches is someone adding one
		// media surface and not the other: an in-flight generation that is invisible
		// with tool detail hidden, and that also makes its message read as empty.
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "data-video-generation", data: { status: "generating" } },
			])
		).toBe(true);
		expect(
			hasVisibleContentAtNoDetail([
				{ type: "file", mediaType: "audio/wav", url: "blob:x" },
			])
		).toBe(true);
	});

	it("is false for a file part with no body — the loop draws nothing for it", () => {
		expect(
			hasVisibleContentAtNoDetail([{ type: "file", mediaType: "image/png" }])
		).toBe(false);
	});

	it("is false for an empty part list", () => {
		expect(hasVisibleContentAtNoDetail([])).toBe(false);
	});

	it("agrees with the render loop on JSON-string tool payloads", () => {
		// The render loop normalises before it draws. A failed tool whose output
		// arrived as a JSON string must still read as visible here, or the turn is
		// dropped and the failure disappears.
		expect(
			hasVisibleContentAtNoDetail([
				{
					type: "tool-Bash",
					state: "output-error",
					input: '{"command":"ls"}',
					output: '{"error":"nope"}',
				},
			])
		).toBe(true);
		expect(
			hasVisibleContentAtNoDetail([
				{
					type: "tool-Bash",
					state: "output-available",
					input: '{"command":"ls"}',
				},
			])
		).toBe(false);
	});
});
