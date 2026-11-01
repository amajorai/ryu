import {
	DEVICE_LIMITS_API_PATH,
	type DeviceLimitSummary,
	isDeviceSurface,
} from "@ryu/auth/lib/device-limits";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

// `GET /api/sessions/device-limits`, fetched with the same origin and bearer
// the shared settings API client uses for `/api/sessions` (both are configured
// from this auth-client's BACKEND_URL and active token; the extension resolves
// `@/lib/auth-client.ts` to its own vault).

const usageSchema = z.object({
	count: z.number().int().nonnegative(),
	label: z.string(),
	limit: z.number().int().nonnegative(),
	surface: z.string().refine(isDeviceSurface),
});

const summarySchema = z.object({
	enforced: z.boolean(),
	surfaces: z.array(usageSchema).max(32),
});

/** Parses the wire summary; malformed rows fail the whole parse. */
export function parseDeviceLimitSummary(value: unknown): DeviceLimitSummary {
	const parsed = summarySchema.parse(value);
	return {
		enforced: parsed.enforced,
		surfaces: parsed.surfaces.flatMap((row) =>
			isDeviceSurface(row.surface) ? [{ ...row, surface: row.surface }] : []
		),
	};
}

export async function fetchDeviceLimitSummary(): Promise<DeviceLimitSummary> {
	const headers = new Headers({ "Content-Type": "application/json" });
	const token = getActiveToken();
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	const base = BACKEND_URL.replace(/\/$/, "");
	const response = await fetch(`${base}${DEVICE_LIMITS_API_PATH}`, {
		credentials: "include",
		headers,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return parseDeviceLimitSummary(await response.json());
}
