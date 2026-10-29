import { describe, expect, test } from "bun:test";
import {
	mergeOutageCandidates,
	normalizeRetryCandidates,
	normalizeStoppedConversations,
	RECONNECT_RETRY_TTL_MS,
	selectPendingRetries,
} from "./reconnect-retry.ts";

const NOW = 1_000_000;

test("durable Stop records reject invalid or expired values and retain the latest timestamp", () => {
	expect(
		normalizeStoppedConversations(
			[
				null,
				{ conversationId: "", capturedAt: NOW },
				{ conversationId: "future", capturedAt: NOW + 1 },
				{ conversationId: "old", capturedAt: NOW - RECONNECT_RETRY_TTL_MS - 1 },
				{ conversationId: "invalid", capturedAt: Number.NaN },
				{ conversationId: "valid", capturedAt: NOW - 10 },
				{ conversationId: "valid", capturedAt: NOW },
			],
			NOW
		)
	).toEqual([{ conversationId: "valid", capturedAt: NOW }]);
});

describe("reconnect retry candidate queue", () => {
	test("captures each running conversation once", () => {
		expect(
			mergeOutageCandidates(
				[{ attempts: 0, capturedAt: NOW - 100, conversationId: "existing" }],
				[
					{ id: "existing", run_status: "running" },
					{ id: "new", run_status: "running" },
					{ id: "done", run_status: "completed" },
				],
				NOW
			)
		).toEqual([
			{ attempts: 0, capturedAt: NOW - 100, conversationId: "existing" },
			{ attempts: 0, capturedAt: NOW, conversationId: "new" },
		]);
	});

	test("retries terminal outage candidates but retains live turns for resume", () => {
		expect(
			selectPendingRetries(
				[
					{ attempts: 0, capturedAt: NOW, conversationId: "failed" },
					{ attempts: 0, capturedAt: NOW, conversationId: "interrupted" },
					{ attempts: 0, capturedAt: NOW, conversationId: "running" },
				],
				[
					{ id: "failed", run_status: "failed" },
					{ id: "interrupted", run_status: "interrupted" },
					{ id: "running", run_status: "running" },
				],
				NOW
			)
		).toEqual({
			retry: [
				{ attempts: 1, capturedAt: NOW, conversationId: "failed" },
				{ attempts: 1, capturedAt: NOW, conversationId: "interrupted" },
			],
			retained: [{ attempts: 0, capturedAt: NOW, conversationId: "running" }],
		});
	});

	test("drops expired records and preserves attempt metadata", () => {
		expect(
			normalizeRetryCandidates(
				[
					{
						attempts: 0,
						capturedAt: NOW - RECONNECT_RETRY_TTL_MS - 1,
						conversationId: "old",
					},
					{ attempts: 1, capturedAt: NOW, conversationId: "attempted" },
				],
				NOW
			)
		).toEqual([{ attempts: 1, capturedAt: NOW, conversationId: "attempted" }]);
	});
});
