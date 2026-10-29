// Core replies are validated before the settings, memory, account and
// conversation views render them. A malformed or partial payload must be
// rejected by the schema, not rendered with missing fields.

import { expect, test } from "bun:test";
import {
	conversationDate,
	conversationListResponseSchema,
} from "./conversation-response.ts";
import {
	coreDataCountsResponseSchema,
	coreMemoryEntryResponseSchema,
	coreMemorySettingsResponseSchema,
	coreMemoryWriteResponseSchema,
	corePreferenceResponseSchema,
	profileNameResponseSchema,
} from "./settings-response-codecs.ts";

const MEMORY = {
	id: "m1",
	content: "likes tea",
	scope: "user",
	scope_id: null,
	category: "preference",
	importance: 0.5,
	when_to_use: null,
	tags: ["drink"],
	author_agent_id: null,
	owner_user_id: "u1",
	provenance: { source: "chat", confidence: null },
	lifecycle: "active",
	created_at: 1,
	updated_at: 2,
};

test("preference reply requires a key and a string-or-null value", () => {
	expect(
		corePreferenceResponseSchema.safeParse({ key: "tone", value: null }).success
	).toBe(true);
	expect(
		corePreferenceResponseSchema.safeParse({ key: "tone", value: 3 }).success
	).toBe(false);
	expect(corePreferenceResponseSchema.safeParse({ value: "x" }).success).toBe(
		false
	);
});

test("native replies keep future fields but reject non-JSON values", () => {
	const withFuture = {
		include_sensitive_topics: true,
		future_field: { nested: [1] },
	};
	const parsed = coreMemorySettingsResponseSchema.safeParse(withFuture);
	expect(parsed.success).toBe(true);
	// The original reply is returned, not a projected copy.
	expect(parsed.data).toBe(withFuture);
	expect(
		coreMemorySettingsResponseSchema.safeParse({
			include_sensitive_topics: true,
			future_field: () => 1,
		}).success
	).toBe(false);
	expect(
		coreMemorySettingsResponseSchema.safeParse({
			include_sensitive_topics: "yes",
		}).success
	).toBe(false);
});

test("memory entry reply rejects an entry missing a required field", () => {
	expect(
		coreMemoryEntryResponseSchema.safeParse({ memory: MEMORY }).success
	).toBe(true);
	const { content: _content, ...withoutContent } = MEMORY;
	expect(
		coreMemoryEntryResponseSchema.safeParse({ memory: withoutContent }).success
	).toBe(false);
	expect(
		coreMemoryEntryResponseSchema.safeParse({
			memory: { ...MEMORY, provenance: {} },
		}).success
	).toBe(false);
});

test("memory write reply accepts a full entry or a bare id, nothing else", () => {
	expect(
		coreMemoryWriteResponseSchema.safeParse({ memory: MEMORY }).success
	).toBe(true);
	expect(coreMemoryWriteResponseSchema.safeParse({ id: "m2" }).success).toBe(
		true
	);
	expect(coreMemoryWriteResponseSchema.safeParse({}).success).toBe(false);
	expect(
		coreMemoryWriteResponseSchema.safeParse({ id: 7, memory: undefined })
			.success
	).toBe(false);
	// A bare-id reply must not smuggle in a malformed entry beside the id.
	expect(
		coreMemoryWriteResponseSchema.safeParse({ id: "m2", memory: { id: "m2" } })
			.success
	).toBe(false);
});

test("data counts reply requires every legacy count as a number", () => {
	const counts = { chats: 1, spaces: 2, memory: 3, monitors: 4, meetings: 5 };
	expect(coreDataCountsResponseSchema.safeParse(counts).success).toBe(true);
	const { meetings: _meetings, ...missing } = counts;
	expect(coreDataCountsResponseSchema.safeParse(missing).success).toBe(false);
	expect(
		coreDataCountsResponseSchema.safeParse({ ...counts, chats: "1" }).success
	).toBe(false);
	expect(
		coreDataCountsResponseSchema.safeParse({
			...counts,
			categories: [{ id: "x" }],
		}).success
	).toBe(false);
});

test("profile name reply requires success: true with message and name", () => {
	expect(
		profileNameResponseSchema.safeParse({
			success: true,
			message: "ok",
			name: "Ada",
		}).success
	).toBe(true);
	expect(
		profileNameResponseSchema.safeParse({
			success: false,
			message: "ok",
			name: "Ada",
		}).success
	).toBe(false);
	expect(
		profileNameResponseSchema.safeParse({ success: true, message: "ok" })
			.success
	).toBe(false);
});

test("conversation list accepts both shapes and rejects rows without an id", () => {
	expect(
		conversationListResponseSchema.safeParse([{ id: "c1", updated_at: 5 }])
			.success
	).toBe(true);
	expect(
		conversationListResponseSchema.safeParse({
			conversations: [{ id: "c1", updated_at: "2024-01-02T00:00:00Z" }],
		}).success
	).toBe(true);
	expect(
		conversationListResponseSchema.safeParse([{ title: "no id" }]).success
	).toBe(false);
	expect(
		conversationListResponseSchema.safeParse([{ id: "c1", pinned: "yes" }])
			.success
	).toBe(false);
	// Unknown fields are kept, so they must still be transport JSON.
	expect(
		conversationListResponseSchema.safeParse([{ id: "c1", extra: () => 1 }])
			.success
	).toBe(false);
});

test("conversationDate accepts epoch milliseconds and ISO strings", () => {
	expect(conversationDate(Date.UTC(2024, 2, 15, 23, 0))).toBe("2024-03-15");
	expect(conversationDate(0)).toBe("1970-01-01");
	expect(conversationDate("2023-11-05T10:20:30Z")).toBe("2023-11-05");
	expect(conversationDate("2023-11-05")).toBe("2023-11-05");
});

test("conversationDate returns null for empty, missing, or out-of-range values", () => {
	expect(conversationDate(null)).toBeNull();
	expect(conversationDate(undefined)).toBeNull();
	expect(conversationDate("")).toBeNull();
	expect(conversationDate("T10:00")).toBeNull();
	expect(conversationDate(8_640_000_000_000_001)).toBeNull();
});
