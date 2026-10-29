import { describe, expect, test } from "bun:test";
import {
	historyPreviewSchema,
	parseHistoryPreview,
} from "./conversation-history.ts";

const fixture = new URL(
	"../../../../../packages/core-client/fixtures/portable-history-preview-v1.json",
	import.meta.url
);

describe("portable history preview v1 contract", () => {
	test("accepts the shared Rust and Desktop fixture", async () => {
		const payload = await Bun.file(fixture).json();
		const preview = parseHistoryPreview(payload);
		expect(preview.transcript.version).toBe(1);
		expect(preview.transcript.messages[0]?.content).toContain(
			"[REDACTED:CUSTOM]"
		);
		expect(preview.redactions.custom).toBe(1);
	});

	test("rejects an unknown format version", async () => {
		const payload = historyPreviewSchema.parse(await Bun.file(fixture).json());
		const transcript = payload.transcript;
		expect(() =>
			parseHistoryPreview({
				...payload,
				transcript: { ...transcript, version: 2 },
			})
		).toThrow("unsupported history preview");
	});
});
