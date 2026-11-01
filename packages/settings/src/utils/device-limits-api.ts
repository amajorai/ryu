/**
 * Device-limit reads for the Sessions & devices settings.
 *
 * `api-client.ts` keeps its `Session` DTO and request helper private, so this
 * module adds the two additive reads the device-limit rollout needs without
 * widening that file: the per-row `surface` field on `GET /api/sessions`, and
 * `GET /api/sessions/device-limits`.
 *
 * The summary is advisory UI only. Any failure (route not deployed yet, an
 * unexpected body, a network error) resolves to null, and the screen simply
 * leaves the usage line out; the auth server alone decides a refusal.
 */

import {
	DEVICE_LIMITS_API_PATH,
	DEVICE_SURFACES,
	type DeviceLimitSummary,
	type DeviceLimitUsage,
	type DeviceSurface,
	isDeviceSurface,
} from "@ryu/auth/lib/device-limits";
import { z } from "zod";
import type { Session } from "./api-client.ts";

/** A `GET /api/sessions` row with the surface the server stamped on it. */
export type SessionWithSurface = Session & { surface?: DeviceSurface };

/** The surface a listed session counts against, when the server sent one. */
export function sessionSurface(session: Session): DeviceSurface | null {
	const surface: unknown = Reflect.get(session, "surface");
	return isDeviceSurface(surface) ? surface : null;
}

const usageSchema = z.object({
	count: z.number().int().min(0),
	label: z.string().max(200),
	limit: z.number().int().min(0),
	surface: z.string(),
});

const summarySchema = z.object({
	enforced: z.boolean(),
	surfaces: z.array(z.unknown()).max(DEVICE_SURFACES.length * 4),
});

/** Validates a summary body; unknown surfaces and malformed rows are dropped. */
export function parseDeviceLimitSummary(
	body: unknown
): DeviceLimitSummary | null {
	const parsed = summarySchema.safeParse(body);
	if (!parsed.success) {
		return null;
	}
	const surfaces: DeviceLimitUsage[] = [];
	for (const row of parsed.data.surfaces) {
		const usage = usageSchema.safeParse(row);
		if (usage.success && isDeviceSurface(usage.data.surface)) {
			surfaces.push({ ...usage.data, surface: usage.data.surface });
		}
	}
	return { enforced: parsed.data.enforced, surfaces };
}

/** Surfaces worth a usage line: enforced and holding at least one device. */
export function occupiedDeviceLimits(
	summary: DeviceLimitSummary | null | undefined
): DeviceLimitUsage[] {
	if (!summary?.enforced) {
		return [];
	}
	return summary.surfaces.filter((usage) => usage.count > 0);
}

/**
 * Next inlines `process.env.NEXT_PUBLIC_SERVER_URL` only when it is written
 * out literally, so the read stays literal; outside Next (no `process`) the
 * guard keeps it from throwing.
 */
function configuredServerUrl(): string | undefined {
	try {
		return process.env.NEXT_PUBLIC_SERVER_URL;
	} catch {
		return undefined;
	}
}

/**
 * Same origin rule as the settings API client on the web, where this tab is
 * mounted: the configured server origin, else the page's own origin. The
 * session cookie authenticates the request.
 */
function deviceLimitsUrl(): string | null {
	const configured = configuredServerUrl();
	if (configured) {
		try {
			return `${new URL(configured).origin}${DEVICE_LIMITS_API_PATH}`;
		} catch {
			return null;
		}
	}
	if (globalThis.window === undefined) {
		return null;
	}
	return `${window.location.origin}${DEVICE_LIMITS_API_PATH}`;
}

/** Reads the per-surface usage summary, or null when it is unavailable. */
export async function fetchDeviceLimitSummary(): Promise<DeviceLimitSummary | null> {
	const url = deviceLimitsUrl();
	if (!url) {
		return null;
	}
	try {
		const response = await fetch(url, {
			credentials: "include",
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			return null;
		}
		return parseDeviceLimitSummary(await response.json());
	} catch {
		return null;
	}
}
