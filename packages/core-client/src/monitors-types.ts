// packages/core-client/src/monitors-types.ts
//
// Wire model and response schemas of the Core website-monitoring client
// (`monitors.ts`), split out of it to keep both files under the hook limits.
// Field names are snake_case to match Core's serde shapes exactly (the Rust
// structs use no rename). `monitors.ts` re-exports the public names.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import {
	type ProviderUsageMeter,
	type ProviderUsageMeterValue,
	type ProviderUsageReading,
	type ProviderUsageWindow,
	providerUsageReadingSchema,
} from "./usage.ts";

export type FetchBackend = "http" | "spider" | "agentbrowser";

export type NumComparator =
	| "changed"
	| "less_than"
	| "greater_than"
	| "drops_by_pct"
	| "rises_by_pct";

// Internally-tagged union mirroring Core's `CheckType` (`{ "type": ... }`).
export type CheckType =
	| { type: "uptime"; expect_status?: number[] }
	| {
			type: "keyword";
			pattern: string;
			is_regex?: boolean;
			case_sensitive?: boolean;
			alert_when_present?: boolean;
	  }
	| { type: "content_diff"; region_regex?: string | null }
	| {
			type: "price";
			extract_regex: string;
			comparator?: NumComparator;
			threshold?: number | null;
	  }
	| {
			type: "stock";
			in_stock_pattern: string;
			is_regex?: boolean;
			alert_when_in_stock?: boolean;
	  }
	| {
			type: "provider_usage_reset";
			provider_id: string;
			/**
			 * The saved account to watch. Absent follows the provider's active
			 * account (a switch re-baselines instead of alerting).
			 */
			account_id?: string | null;
			target_ids: string[];
			minimum_drop_percent: number;
	  };

export interface UsageProviderOption {
	/** Saved accounts, label-free (agents must never see login names). */
	accounts?: UsageProviderAccountOption[];
	/** Whether Core can read one saved account at a time. Absent on older Core. */
	capabilities?: { accountUsage: boolean };
	kind: "subscription" | "api_credits";
	label: string;
	providerId: string;
}

/** One saved account in the MCP `usage.providers` catalog. */
export interface UsageProviderAccountOption {
	accountId: string;
	active: boolean;
	kind: string;
	needsReauth: boolean;
}

/** A projected usage window; see `ProviderUsageWindow` in `./usage.ts`. */
export type UsageWindowTarget = ProviderUsageWindow;

/** One meter figure; see `ProviderUsageMeterValue` in `./usage.ts`. */
export type UsageMeterValueTarget = ProviderUsageMeterValue;

/** A projected meter; see `ProviderUsageMeter` in `./usage.ts`. */
export type UsageMeterTarget = ProviderUsageMeter;

/**
 * The monitors usage query returns the canonical reading. `accountId`,
 * `accountLabel`, `observedAt` and `cached` are absent on older Core.
 */
export type ProviderUsageSnapshot = ProviderUsageReading;

export type NotifyTarget =
	| { kind: "webhook"; url: string }
	| { kind: "telegram"; bot_token: string; chat_id: string }
	| { kind: "expo_push"; token: string }
	| { kind: "email"; to: string };

export type CheckStatus = "ok" | "triggered" | "error";

/**
 * The GET view of a notify target. Credentials come back redacted; `secret_ref`
 * names the stored credential so a save that echoes the placeholder keeps the
 * right one. Send it back unchanged with the target.
 */
export type PublicNotifyTarget = (
	| Exclude<NotifyTarget, { kind: "telegram" }>
	| {
			kind: "telegram";
			chat_id: string;
			has_bot_token?: boolean;
			bot_token?: string;
	  }
) & { secret_ref?: string };

export interface Monitor {
	backend: FetchBackend;
	check: CheckType;
	created_at: string;
	enabled: boolean;
	id: string;
	interval: string;
	last_check_at?: string | null;
	last_status?: CheckStatus | null;
	last_value?: string | null;
	name: string;
	notify: PublicNotifyTarget[];
	updated_at: string;
	url: string;
}

export interface Snapshot {
	checked_at: string;
	content_hash?: string | null;
	http_status?: number | null;
	id: number;
	latency_ms?: number | null;
	monitor_id: string;
	note?: string | null;
	status: CheckStatus;
	value?: string | null;
}

export interface Alert {
	acknowledged: boolean;
	created_at: string;
	id: number;
	kind: string;
	message: string;
	monitor_id: string;
	monitor_name: string;
	title: string;
}

export const alertSchema = z.object({
	acknowledged: z.boolean(),
	created_at: z.string(),
	id: z.number(),
	kind: z.string(),
	message: z.string(),
	monitor_id: z.string(),
	monitor_name: z.string(),
	title: z.string(),
});

// Full native monitor/store and Core usage-tool response fields. Validation
// observes the complete native shape while returning the original JSON tree.
const checkStatusFields = z.enum(["ok", "triggered", "error"]);
const comparatorFields = z.enum([
	"changed",
	"less_than",
	"greater_than",
	"drops_by_pct",
	"rises_by_pct",
]);
const checkFields = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("uptime"),
		expect_status: z.array(z.number()).optional(),
	}),
	z.object({
		type: z.literal("keyword"),
		pattern: z.string(),
		is_regex: z.boolean().optional(),
		case_sensitive: z.boolean().optional(),
		alert_when_present: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("content_diff"),
		region_regex: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("price"),
		extract_regex: z.string(),
		comparator: comparatorFields.optional(),
		threshold: z.number().nullable().optional(),
	}),
	z.object({
		type: z.literal("stock"),
		in_stock_pattern: z.string(),
		is_regex: z.boolean().optional(),
		alert_when_in_stock: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("provider_usage_reset"),
		provider_id: z.string(),
		account_id: z.string().nullish(),
		target_ids: z.array(z.string()),
		minimum_drop_percent: z.number(),
	}),
]);
const notifyFields = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("webhook"), url: z.string() }),
	z.object({
		kind: z.literal("telegram"),
		chat_id: z.string(),
		has_bot_token: z.boolean().optional(),
		bot_token: z.string().optional(),
	}),
	z.object({ kind: z.literal("expo_push"), token: z.string() }),
	z.object({ kind: z.literal("email"), to: z.string() }),
]);
// Native write targets require a Telegram token string. Validation returns the
// raw targets so future fields and reference identity survive a form round-trip.
const notifyInputFields = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("webhook"), url: z.string() }),
	z.object({
		kind: z.literal("telegram"),
		chat_id: z.string(),
		bot_token: z.string(),
	}),
	z.object({ kind: z.literal("expo_push"), token: z.string() }),
	z.object({ kind: z.literal("email"), to: z.string() }),
]);
const notifyInputsFields = z.array(notifyInputFields);
export const monitorNotifyTargetsInputSchema = z.custom<
	z.output<typeof notifyInputsFields>
>((value) => notifyInputsFields.safeParse(value).success);

const monitorFields = z.object({
	backend: z.enum(["http", "spider", "agentbrowser"]),
	check: checkFields,
	created_at: z.string(),
	enabled: z.boolean(),
	id: z.string(),
	interval: z.string(),
	last_check_at: z.string().nullable().optional(),
	last_status: checkStatusFields.nullable().optional(),
	last_value: z.string().nullable().optional(),
	name: z.string(),
	notify: z.array(notifyFields),
	updated_at: z.string(),
	url: z.string(),
});
const snapshotFields = z.object({
	checked_at: z.string(),
	content_hash: z.string().nullable().optional(),
	http_status: z.number().nullable().optional(),
	id: z.number(),
	latency_ms: z.number().nullable().optional(),
	monitor_id: z.string(),
	note: z.string().nullable().optional(),
	status: checkStatusFields,
	value: z.string().nullable().optional(),
});
const providerAccountFields = z.object({
	accountId: z.string(),
	active: z.boolean(),
	kind: z.string(),
	needsReauth: z.boolean(),
});
const providerFields = z.object({
	accounts: z.array(providerAccountFields).optional(),
	capabilities: z.object({ accountUsage: z.boolean() }).optional(),
	kind: z.enum(["subscription", "api_credits"]),
	label: z.string(),
	providerId: z.string(),
});
const providersResponseFields = z.object({
	providers: z.array(providerFields).optional(),
});
const monitorsResponseFields = z.object({
	monitors: z.array(monitorFields).optional(),
	error: z.string().optional(),
});
const monitorResponseFields = z.object({
	monitor: monitorFields.optional(),
	error: z.string().optional(),
});
const runResponseFields = z.object({
	status: checkStatusFields.optional(),
	error: z.string().optional(),
});
const snapshotsResponseFields = z.object({
	snapshots: z.array(snapshotFields).optional(),
	error: z.string().optional(),
});
const alertsResponseFields = z.object({
	alerts: z.array(alertSchema).optional(),
	error: z.string().optional(),
});
const okResponseFields = z.object({ ok: z.boolean() });
export const providersResponseSchema = z.custom<
	z.output<typeof providersResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		providersResponseFields.safeParse(value).success
);
export const usageResponseSchema = z.custom<ProviderUsageReading>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		providerUsageReadingSchema.safeParse(value).success
);
export const monitorsResponseSchema = z.custom<
	z.output<typeof monitorsResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		monitorsResponseFields.safeParse(value).success
);
export const monitorResponseSchema = z.custom<
	z.output<typeof monitorResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		monitorResponseFields.safeParse(value).success
);
export const runResponseSchema = z.custom<z.output<typeof runResponseFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		runResponseFields.safeParse(value).success
);
export const snapshotsResponseSchema = z.custom<
	z.output<typeof snapshotsResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		snapshotsResponseFields.safeParse(value).success
);
export const alertsResponseSchema = z.custom<
	z.output<typeof alertsResponseFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		alertsResponseFields.safeParse(value).success
);
export const okResponseSchema = z.custom<z.output<typeof okResponseFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		okResponseFields.safeParse(value).success
);

/** The fields needed to create or update a monitor. */
export interface MonitorInput {
	backend: FetchBackend;
	check: CheckType;
	enabled: boolean;
	interval: string;
	name: string;
	notify: NotifyTarget[];
	url: string;
}
