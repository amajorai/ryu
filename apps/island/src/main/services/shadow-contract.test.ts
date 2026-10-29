import { expect, test } from "bun:test";
import type { SpeechHistory } from "@ryuhq/core-client/shadow";
import type { SuggestionDisposition } from "../../shared/ipc.ts";
import {
	captureControlSchema,
	proactiveResponseSchema,
	shadowContextSchema,
	speechHistorySchema,
} from "./shadow-contract.ts";

test("context and capture-control responses preserve nullable fields and app policy", () => {
	const context = {
		app_name: "Editor",
		capture_active: false,
		ocr_text: null,
		ocr_timestamp_us: null,
		paused: true,
		selected_text: "selected",
		timestamp_us: 123,
		window_title: null,
	};
	expect(shadowContextSchema.parse(context)).toEqual(context);
	expect(
		shadowContextSchema.safeParse({ ...context, paused: "false" }).success
	).toBe(false);
	expect(
		captureControlSchema.parse({ paused: true, app_allowlist: ["Editor"] })
	).toEqual({ paused: true, app_allowlist: ["Editor"] });
	expect(
		captureControlSchema.safeParse({ paused: false, app_allowlist: [42] })
			.success
	).toBe(false);
});

test("proactive responses retain disposition, order, and nested metadata", () => {
	const dispositions = [
		"drop",
		"inbox_only",
		"push_now",
	] satisfies SuggestionDisposition[];
	const suggestions = dispositions.map((disposition) => ({
		body: null,
		confidence: 0.8,
		created_at: 123,
		disposition,
		id: disposition,
		metadata: { context: { app: "Editor", lines: [1, 2] } },
		suggestion_type: "context",
		title: "Review",
	}));
	expect(proactiveResponseSchema.parse({ suggestions })).toEqual({
		suggestions,
	});
	expect(proactiveResponseSchema.parse({})).toEqual({});
	expect(
		proactiveResponseSchema.safeParse({
			suggestions: [{ ...suggestions[0], disposition: "future" }],
		}).success
	).toBe(false);
});

test("speech history preserves pagination, timing, and truncated status", () => {
	const history = {
		nextOffset: 20,
		segments: [
			{
				endedAt: "end",
				id: "one",
				startedAt: "start",
				text: "hello",
				timing: "window",
			},
		],
		truncated: true,
	} satisfies SpeechHistory;
	expect(speechHistorySchema.parse(history)).toEqual(history);
	expect(speechHistorySchema.parse({ nextOffset: null, segments: [] })).toEqual(
		{ nextOffset: null, segments: [] }
	);
	expect(
		speechHistorySchema.safeParse({ ...history, nextOffset: "20" }).success
	).toBe(false);
});
