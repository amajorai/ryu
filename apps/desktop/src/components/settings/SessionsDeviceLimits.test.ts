import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	DEVICE_SURFACE_LABELS,
	DEVICE_SURFACES,
	deviceLimitReachedMessage,
} from "@ryu/auth/lib/device-limits";
import { formatMessage } from "@ryu/i18n/core";

mock.module(
	fileURLToPath(new URL("../../../lib/auth-client.ts", import.meta.url)),
	() => ({
		BACKEND_URL: "http://127.0.0.1:1",
		getActiveToken: () => null,
	})
);
const { deviceSurfaceLabels, sessionSurface } = await import(
	"./SessionsDeviceLimits.tsx"
);
const { localizedDeviceLimitMessage, signInErrorDescription } = await import(
	"../../lib/device-limit-copy.ts"
);
const { DEVICE_LIMIT_GENERIC_MESSAGE, DeviceLimitReachedError } = await import(
	"../../../lib/device-limit-error.ts"
);
const { parseDeviceLimitSummary } = await import("./device-limits-api.ts");

const identity = ((source: string) => source) as Parameters<
	typeof deviceSurfaceLabels
>[0];

test("localized surface literals mirror the shared contract labels", () => {
	expect(deviceSurfaceLabels(identity)).toEqual({ ...DEVICE_SURFACE_LABELS });
});

// English formatting, as `useLiteralMessages` does without a catalog.
const english = ((source: string, values?: Record<string, unknown>) =>
	formatMessage(source, values)) as Parameters<typeof deviceSurfaceLabels>[0];

test("the localized refusal sentence matches the contract sentence in English", () => {
	for (const surface of DEVICE_SURFACES) {
		for (const limit of [1, 5]) {
			const error = new DeviceLimitReachedError({
				error: "device_limit_reached",
				limit,
				surface,
			});
			expect(localizedDeviceLimitMessage(english, error)).toBe(
				deviceLimitReachedMessage(surface, limit)
			);
		}
	}
	expect(
		localizedDeviceLimitMessage(
			english,
			new DeviceLimitReachedError("device_limit_reached")
		)
	).toBe(DEVICE_LIMIT_GENERIC_MESSAGE);
});

test("other sign-in errors keep their own message", () => {
	expect(signInErrorDescription(english, new Error("Access denied."))).toBe(
		"Access denied."
	);
});

test("a session row names its surface only when the API sent a known one", () => {
	expect(sessionSurface({ id: "a", surface: "desktop" })).toBe("desktop");
	expect(sessionSurface({ id: "a", surface: "toaster" })).toBeNull();
	expect(sessionSurface({ id: "a" })).toBeNull();
});

test("the usage summary keeps every surface row and rejects malformed counts", () => {
	const surfaces = DEVICE_SURFACES.map((surface) => ({
		count: 1,
		label: DEVICE_SURFACE_LABELS[surface],
		limit: 5,
		surface,
	}));
	expect(parseDeviceLimitSummary({ enforced: true, surfaces })).toEqual({
		enforced: true,
		surfaces,
	});
	expect(() =>
		parseDeviceLimitSummary({
			enforced: true,
			surfaces: [{ ...surfaces[0], count: -1 }],
		})
	).toThrow();
	expect(() =>
		parseDeviceLimitSummary({
			enforced: true,
			surfaces: [{ ...surfaces[0], surface: "toaster" }],
		})
	).toThrow();
	expect(() => parseDeviceLimitSummary({ surfaces })).toThrow();
});
