import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";

export const PRIVACY_KEYS = {
	analytics: "product-analytics-enabled",
	community: "community-stats-enabled",
	profileActivity: "profile-activity-enabled",
	crashReports: "crash-reports-enabled",
	diagnosticsExport: "diagnostics-export-enabled",
	diagnosticsEndpoint: "diagnostics-otlp-endpoint",
	diagnosticsContentMode: "diagnostics-otlp-content-mode",
	supportAccess: "support-access-local-enabled",
	supportExpiry: "support-access-local-expiry",
} as const;

export const PRIVACY_KEY_ORDER = [
	PRIVACY_KEYS.analytics,
	PRIVACY_KEYS.community,
	PRIVACY_KEYS.profileActivity,
	PRIVACY_KEYS.crashReports,
	PRIVACY_KEYS.diagnosticsExport,
	PRIVACY_KEYS.diagnosticsEndpoint,
	PRIVACY_KEYS.diagnosticsContentMode,
	PRIVACY_KEYS.supportAccess,
	PRIVACY_KEYS.supportExpiry,
] as const;

export const DEFAULTS: PrivacyPreferences = {
	analytics: true,
	community: true,
	profileActivity: true,
	crashReports: true,
	diagnosticsExport: false,
	diagnosticsEndpoint: "",
	diagnosticsContentMode: "metadata_only",
	supportAccess: false,
	supportExpiry: 0,
};

export const SUPPORT_DURATION_HOURS = [1, 8, 24] as const;
export const SUPPORT_DURATION_INDEX = new Map<number, number>(
	SUPPORT_DURATION_HOURS.map((duration, index) => [duration, index])
);
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ROWS = [
	"analytics",
	"community",
	"profileActivity",
	"crashReports",
	"diagnosticsExport",
	"diagnosticsEndpoint",
	"diagnosticsContentMode",
	"supportDuration",
	"supportAccess",
] as const;

export type DiagnosticsContentMode = "metadata_only" | "content";

export interface PrivacyPreferences {
	analytics: boolean;
	community: boolean;
	crashReports: boolean;
	diagnosticsContentMode: DiagnosticsContentMode;
	diagnosticsEndpoint: string;
	diagnosticsExport: boolean;
	profileActivity: boolean;
	supportAccess: boolean;
	supportExpiry: number;
}

const privacyPreferenceSchema = z.object({ value: z.json().optional() });
type PreferenceWire = z.infer<typeof privacyPreferenceSchema>;
type PrivacyPreferenceValue = PreferenceWire["value"];
const privacyStringSchema = z.string();
const privacyErrorSchema = z.instanceof(Error);
export const testSpanResponseSchema = z.object({ endpoint: z.string() });
export function requestPrivacyPreference(target: ApiTarget, path: string) {
	return request(target, path, {}, appResponseValueSchema).then((raw) =>
		privacyPreferenceSchema.parse(raw)
	);
}

export interface PreferenceWrite {
	key: string;
	value: string;
}

export interface SaveIntent {
	closeEndpointEditor?: boolean;
	label: string;
	next: Partial<PrivacyPreferences>;
	previous: Partial<PrivacyPreferences>;
	writes: readonly PreferenceWrite[];
}

export function parseBoolean(
	raw: PrivacyPreferenceValue,
	fallback: boolean
): boolean {
	const parsed = privacyStringSchema.safeParse(raw);
	if (!parsed.success) {
		return fallback;
	}
	switch (parsed.data.trim().toLowerCase()) {
		case "true":
		case "1":
		case "on":
		case "yes":
			return true;
		case "false":
		case "0":
		case "off":
		case "no":
			return false;
		default:
			return fallback;
	}
}

/** Mirrors Core's tolerant `ContentMode::parse`: only `content` (or `full`)
 * opts in; anything else keeps the metadata-only default. */
export function parseContentMode(
	raw: string | null | undefined
): DiagnosticsContentMode {
	const value = raw?.trim().toLowerCase();
	return value === "content" || value === "full" ? "content" : "metadata_only";
}

export function rawValue(wire: PreferenceWire): string | null {
	const parsed = privacyStringSchema.safeParse(wire.value);
	return parsed.success ? parsed.data : null;
}

export function errorMessage(
	error: Parameters<typeof privacyErrorSchema.safeParse>[0]
): string {
	const parsed = privacyErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}

export function parseExpiry(raw: string | null): number {
	if (raw === null) {
		return 0;
	}
	const parsed = Number(raw.trim());
	return Number.isFinite(parsed) ? parsed : 0;
}
