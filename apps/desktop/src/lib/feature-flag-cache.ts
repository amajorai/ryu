import {
	type AppRequestValue,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";

// Older caches can include malformed individual flags or an array. Keep their
// native JSON values; only actual boolean entries are readable as feature flags.
const featureValueFieldsSchema = z.record(z.string(), appRequestValueSchema);
const featureValuesSchema = z.preprocess(
	(value) => (Array.isArray(value) ? { ...value } : value),
	z.custom<z.output<typeof featureValueFieldsSchema>>(
		(value) =>
			featureValueFieldsSchema.safeParse(value).success &&
			appRequestValueSchema.safeParse(value).success
	)
);
const timestampSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const storedFeatureFlagsSchema = z.object({
	accountId: z.string(),
	features: featureValuesSchema,
	fetchedAtMs: timestampSchema.catch(0),
	// Absent on records written before flags were org-scoped. Such a record was
	// fetched under an unknown org, so it reads as UNSCOPED (null): usable only
	// while no organization is active, never inside one.
	orgId: z.string().nullish(),
});
export type StoredFeatureFlags = z.output<typeof storedFeatureFlagsSchema>;

/**
 * Who a flag map was served for. Audiences can target the account itself and
 * its role in the ACTIVE organization (`org_role` / `org_admin`), so a map is
 * only valid for the exact (account, org) pair it was fetched under.
 */
export interface FeatureFlagScope {
	accountId: string;
	/** The active organization, or null when the session has none. */
	orgId: string | null;
}

/** Whether two scopes name the same (account, org) pair. */
export function sameFeatureFlagScope(
	left: FeatureFlagScope | null,
	right: FeatureFlagScope | null
): boolean {
	return (
		left !== null &&
		right !== null &&
		left.accountId === right.accountId &&
		left.orgId === right.orgId
	);
}

/** Whether a decoded record belongs to `scope` (legacy org-less records are unscoped). */
export function storedFeatureFlagsMatchScope(
	record: StoredFeatureFlags,
	scope: FeatureFlagScope
): boolean {
	return (
		record.accountId === scope.accountId &&
		(record.orgId ?? null) === scope.orgId
	);
}

type StoredFeatureFlagsInput = Parameters<
	typeof storedFeatureFlagsSchema.parse
>[0];

/** Decode a persisted record whatever scope it was written for. */
export function decodeStoredFeatureFlags(
	value: StoredFeatureFlagsInput
): StoredFeatureFlags | null {
	const parsed = storedFeatureFlagsSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Decode this scope's persisted cache without accepting another scope's flags. */
export function parseStoredFeatureFlags(
	value: StoredFeatureFlagsInput,
	scope: FeatureFlagScope
): StoredFeatureFlags | null {
	const record = decodeStoredFeatureFlags(value);
	return record && storedFeatureFlagsMatchScope(record, scope) ? record : null;
}

/**
 * How many (account, org) scopes are kept per account, and in all. Bounded so a
 * user who visits many orgs cannot grow the store without limit; eight covers
 * switching back and forth between a person's real orgs. Least recently
 * PUBLISHED goes first: every switch revalidates its scope, and that refresh is
 * the publish that marks the scope as recently used.
 */
export const MAX_FEATURE_FLAG_SCOPES_PER_ACCOUNT = 8;
export const MAX_FEATURE_FLAG_SCOPES = 32;

/** The persisted shape: most recently published first. */
const storedFeatureFlagScopesSchema = z.object({
	records: z.array(z.unknown()),
	version: z.literal(2),
});

/**
 * Decode every persisted scope, most recently published first. A single record
 * written before the cache held several scopes reads as a one-entry list, and a
 * malformed entry is dropped without discarding its neighbours.
 */
export function decodeStoredFeatureFlagScopes(
	value: StoredFeatureFlagsInput
): StoredFeatureFlags[] {
	const list = storedFeatureFlagScopesSchema.safeParse(value);
	if (!list.success) {
		const legacy = decodeStoredFeatureFlags(value);
		return legacy ? [legacy] : [];
	}
	const records: StoredFeatureFlags[] = [];
	for (const entry of list.data.records) {
		const record = decodeStoredFeatureFlags(entry);
		if (
			record &&
			findStoredFeatureFlags(records, recordScope(record)) === null
		) {
			records.push(record);
		}
	}
	return records;
}

function recordScope(record: StoredFeatureFlags): FeatureFlagScope {
	return { accountId: record.accountId, orgId: record.orgId ?? null };
}

/** The value to persist for `records` (already most recent first). */
export function encodeStoredFeatureFlagScopes(records: StoredFeatureFlags[]): {
	records: StoredFeatureFlags[];
	version: 2;
} {
	return { records, version: 2 };
}

/** This scope's record from a decoded list, or null when it has none. */
export function findStoredFeatureFlags(
	records: readonly StoredFeatureFlags[],
	scope: FeatureFlagScope
): StoredFeatureFlags | null {
	return (
		records.find((record) => storedFeatureFlagsMatchScope(record, scope)) ??
		null
	);
}

/**
 * Put `record` first, replacing its scope's previous record, and evict the
 * least recently published scopes beyond the per-account and overall bounds.
 */
export function upsertStoredFeatureFlags(
	records: readonly StoredFeatureFlags[],
	record: StoredFeatureFlags
): StoredFeatureFlags[] {
	const scope = recordScope(record);
	const kept: StoredFeatureFlags[] = [record];
	const perAccount = new Map<string, number>([[record.accountId, 1]]);
	for (const existing of records) {
		if (kept.length >= MAX_FEATURE_FLAG_SCOPES) {
			break;
		}
		if (storedFeatureFlagsMatchScope(existing, scope)) {
			continue;
		}
		const count = perAccount.get(existing.accountId) ?? 0;
		if (count >= MAX_FEATURE_FLAG_SCOPES_PER_ACCOUNT) {
			continue;
		}
		perAccount.set(existing.accountId, count + 1);
		kept.push(existing);
	}
	return kept;
}

export function storedFeatureFlagValue(value: AppRequestValue): boolean | null {
	const parsed = z.boolean().safeParse(value);
	return parsed.success ? parsed.data : null;
}
