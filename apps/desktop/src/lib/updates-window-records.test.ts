import { describe, expect, test } from "bun:test";
import {
	parseScopedUpdatesRecord,
	updatesNagRecordSchema,
	updatesWindowRecordSchema,
} from "./updates-window-records.ts";

describe("account-scoped updater storage", () => {
	test("accepts the owning account and ignores additive saved fields", () => {
		const raw =
			'{"accountId":"alice","windowEndsAt":"2030-01-02T00:00:00Z","__proto__":{"future":true},"future":[1,null]}';
		expect(
			parseScopedUpdatesRecord(raw, "alice", updatesWindowRecordSchema)
		).toEqual({
			accountId: "alice",
			windowEndsAt: "2030-01-02T00:00:00Z",
		});
		expect(
			parseScopedUpdatesRecord(raw, "bob", updatesWindowRecordSchema)
		).toBeNull();
		expect(
			parseScopedUpdatesRecord(raw, null, updatesWindowRecordSchema)
		).toBeNull();
	});

	test("corrupt or unowned storage remains fail-open", () => {
		for (const raw of [
			null,
			"",
			"not-json",
			"null",
			"42",
			"[]",
			'{"accountId":null,"windowEndsAt":"2030-01-02"}',
			'{"accountId":"alice"}',
			'{"accountId":"alice","windowEndsAt":123}',
		]) {
			expect(
				parseScopedUpdatesRecord(raw, "alice", updatesWindowRecordSchema)
			).toBeNull();
		}
	});

	test("nag records require the exact owned string version independently of dates", () => {
		const raw = JSON.stringify({
			accountId: "alice",
			version: "1.2.3",
			windowEndsAt: false,
		});
		expect(
			parseScopedUpdatesRecord(raw, "alice", updatesNagRecordSchema)?.version
		).toBe("1.2.3");
		expect(
			parseScopedUpdatesRecord(raw, "bob", updatesNagRecordSchema)
		).toBeNull();
		for (const version of [null, 123, true, [], {}]) {
			expect(
				parseScopedUpdatesRecord(
					JSON.stringify({ accountId: "alice", version }),
					"alice",
					updatesNagRecordSchema
				)
			).toBeNull();
		}
	});
});
