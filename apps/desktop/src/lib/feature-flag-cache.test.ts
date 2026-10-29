import { describe, expect, it } from "bun:test";
import {
	decodeStoredFeatureFlagScopes,
	encodeStoredFeatureFlagScopes,
	findStoredFeatureFlags,
	MAX_FEATURE_FLAG_SCOPES,
	MAX_FEATURE_FLAG_SCOPES_PER_ACCOUNT,
	parseStoredFeatureFlags,
	type StoredFeatureFlags,
	sameFeatureFlagScope,
	storedFeatureFlagValue,
	upsertStoredFeatureFlags,
} from "./feature-flag-cache.ts";

const ONE = { accountId: "one", orgId: null };

describe("account- and org-scoped feature flag storage", () => {
	it("keeps valid flags beside malformed legacy entries and original metadata", () => {
		const features = JSON.parse(
			'{"enabled":true,"disabled":false,"future":{"nested":[null,"value"]},"__proto__":true}'
		);
		const record = parseStoredFeatureFlags(
			{ accountId: "one", features, fetchedAtMs: 12 },
			ONE
		);
		expect(record?.features).toBe(features);
		expect(storedFeatureFlagValue(record?.features.enabled)).toBe(true);
		expect(storedFeatureFlagValue(record?.features.disabled)).toBe(false);
		expect(storedFeatureFlagValue(record?.features.future)).toBeNull();
		expect(storedFeatureFlagValue(record?.features.__proto__)).toBe(true);
		expect(storedFeatureFlagValue(record?.features.absent)).toBeNull();
	});
	it("never reads another account's flags", () => {
		expect(
			parseStoredFeatureFlags(
				{ accountId: "one", features: { enabled: true } },
				{ accountId: "two", orgId: null }
			)
		).toBeNull();
		expect(
			parseStoredFeatureFlags(
				{ accountId: null, features: { enabled: true } },
				ONE
			)
		).toBeNull();
	});
	it("never reads another organization's flags", () => {
		const record = {
			accountId: "one",
			features: { enabled: true },
			orgId: "org-a",
		};
		expect(
			parseStoredFeatureFlags(record, { accountId: "one", orgId: "org-a" })
		).not.toBeNull();
		expect(
			parseStoredFeatureFlags(record, { accountId: "one", orgId: "org-b" })
		).toBeNull();
		expect(parseStoredFeatureFlags(record, ONE)).toBeNull();
		expect(
			parseStoredFeatureFlags(record, { accountId: "two", orgId: "org-a" })
		).toBeNull();
	});
	it("treats records without an org as unscoped", () => {
		for (const legacy of [
			{ accountId: "one", features: { enabled: true } },
			{ accountId: "one", features: { enabled: true }, orgId: null },
		]) {
			expect(parseStoredFeatureFlags(legacy, ONE)?.orgId ?? null).toBeNull();
			expect(
				parseStoredFeatureFlags(legacy, { accountId: "one", orgId: "org-a" })
			).toBeNull();
		}
		expect(
			parseStoredFeatureFlags({ accountId: "one", features: {}, orgId: 7 }, ONE)
		).toBeNull();
	});
	it("compares scopes by account and org", () => {
		expect(sameFeatureFlagScope(ONE, { accountId: "one", orgId: null })).toBe(
			true
		);
		expect(sameFeatureFlagScope(ONE, { accountId: "one", orgId: "org" })).toBe(
			false
		);
		expect(sameFeatureFlagScope(ONE, null)).toBe(false);
		expect(sameFeatureFlagScope(null, null)).toBe(false);
	});
	it("retains legacy arrays and timestamp defaults", () => {
		const record = parseStoredFeatureFlags(
			{ accountId: "one", features: [true, "false", false] },
			ONE
		);
		expect(record?.fetchedAtMs).toBe(0);
		expect(storedFeatureFlagValue(record?.features[0])).toBe(true);
		expect(storedFeatureFlagValue(record?.features[1])).toBeNull();
		expect(storedFeatureFlagValue(record?.features[2])).toBe(false);
		const overflow = JSON.parse(
			'{"accountId":"one","features":{},"fetchedAtMs":1e400}'
		);
		expect(parseStoredFeatureFlags(overflow, ONE)?.fetchedAtMs).toBe(
			Number.POSITIVE_INFINITY
		);
	});
	it("rejects invalid roots without inventing boolean values", () => {
		for (const features of [null, true, "flags", 4]) {
			expect(
				parseStoredFeatureFlags({ accountId: "one", features }, ONE)
			).toBeNull();
		}
		for (const value of [undefined, null, 0, 1, "true", "false", [], {}]) {
			expect(storedFeatureFlagValue(value)).toBeNull();
		}
	});
});

function stored(accountId: string, orgId: string | null): StoredFeatureFlags {
	return { accountId, features: { enabled: true }, fetchedAtMs: 1, orgId };
}

describe("several stored feature flag scopes", () => {
	it("reads a legacy single record as a one-entry list", () => {
		expect(
			decodeStoredFeatureFlagScopes({ accountId: "one", features: {} })
		).toHaveLength(1);
		expect(decodeStoredFeatureFlagScopes({ features: {} })).toEqual([]);
		expect(decodeStoredFeatureFlagScopes(null)).toEqual([]);
	});
	it("drops malformed and duplicate entries but keeps their neighbours", () => {
		const records = decodeStoredFeatureFlagScopes({
			records: [
				stored("one", "org-a"),
				{ accountId: 3, features: {} },
				stored("one", "org-a"),
				stored("one", null),
			],
			version: 2,
		});
		expect(records.map((record) => record.orgId)).toEqual(["org-a", null]);
		expect(
			findStoredFeatureFlags(records, { accountId: "one", orgId: null })
		).not.toBeNull();
		expect(
			findStoredFeatureFlags(records, { accountId: "one", orgId: "org-b" })
		).toBeNull();
	});
	it("puts the published scope first and replaces its previous record", () => {
		const first = upsertStoredFeatureFlags([], stored("one", "org-a"));
		const second = upsertStoredFeatureFlags(first, stored("one", "org-b"));
		const updated = { ...stored("one", "org-a"), fetchedAtMs: 9 };
		const third = upsertStoredFeatureFlags(second, updated);
		expect(third.map((record) => record.orgId)).toEqual(["org-a", "org-b"]);
		expect(third[0]?.fetchedAtMs).toBe(9);
		const encoded = JSON.parse(
			JSON.stringify(encodeStoredFeatureFlagScopes(third))
		);
		expect(decodeStoredFeatureFlagScopes(encoded)).toEqual(third);
	});
	it("evicts the least recently published scopes beyond the bounds", () => {
		let records: StoredFeatureFlags[] = [stored("two", "org-x")];
		for (
			let index = 0;
			index <= MAX_FEATURE_FLAG_SCOPES_PER_ACCOUNT;
			index += 1
		) {
			records = upsertStoredFeatureFlags(
				records,
				stored("one", `org-${index}`)
			);
		}
		const own = records.filter((record) => record.accountId === "one");
		expect(own).toHaveLength(MAX_FEATURE_FLAG_SCOPES_PER_ACCOUNT);
		expect(own.at(-1)?.orgId).toBe("org-1");
		expect(records.some((record) => record.accountId === "two")).toBe(true);

		let many: StoredFeatureFlags[] = [];
		for (let index = 0; index < MAX_FEATURE_FLAG_SCOPES + 4; index += 1) {
			many = upsertStoredFeatureFlags(many, stored(`account-${index}`, null));
		}
		expect(many).toHaveLength(MAX_FEATURE_FLAG_SCOPES);
		expect(many[0]?.accountId).toBe(`account-${MAX_FEATURE_FLAG_SCOPES + 3}`);
	});
});
