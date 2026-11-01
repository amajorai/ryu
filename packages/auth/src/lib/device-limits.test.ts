import { describe, expect, test } from "bun:test";
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_LIMIT_REACHED_CODE,
	DEVICE_LIMIT_REACHED_ERROR,
	DEVICE_SURFACE_LABELS,
	DEVICE_SURFACES,
	declaredDeviceSurface,
	deviceLimitReachedMessage,
	deviceSurfaceScopeToken,
	isDeviceSurface,
	parseDeviceLimitRefusal,
} from "./device-limits.ts";

const REFUSAL = {
	code: DEVICE_LIMIT_REACHED_CODE,
	error: DEVICE_LIMIT_REACHED_ERROR,
	error_description: deviceLimitReachedMessage("desktop", 5),
	limit: 5,
	message: deviceLimitReachedMessage("desktop", 5),
	surface: "desktop",
};

describe("device limit contract", () => {
	test("every surface has a label and a default cap", () => {
		for (const surface of DEVICE_SURFACES) {
			expect(DEVICE_SURFACE_LABELS[surface].length).toBeGreaterThan(0);
			expect(DEVICE_LIMIT_DEFAULTS[surface]).toBeGreaterThan(0);
		}
		expect(isDeviceSurface("desktop")).toBe(true);
		expect(isDeviceSurface("Desktop")).toBe(false);
		expect(isDeviceSurface(3)).toBe(false);
	});

	test("the refusal message names the cap and the surface", () => {
		expect(deviceLimitReachedMessage("cli", 5)).toBe(
			"Device limit reached for CLI and MCP: this account is already signed in on the maximum of 5 devices. Sign out of one you no longer use, then try again."
		);
		expect(deviceLimitReachedMessage("desktop", 1)).toContain(
			"Ryu Desktop: this account is already signed in on the maximum of 1 device."
		);
	});
});

describe("declaredDeviceSurface", () => {
	test("reads the surface token out of a scope string", () => {
		expect(
			declaredDeviceSurface(
				`openid profile ${deviceSurfaceScopeToken("desktop")} email`
			)
		).toBe("desktop");
		expect(declaredDeviceSurface("ryu:surface:self_hosted")).toBe(
			"self_hosted"
		);
	});

	test("ignores missing, unknown, and oversized declarations", () => {
		expect(declaredDeviceSurface("openid profile")).toBeNull();
		expect(declaredDeviceSurface("ryu:surface:toaster")).toBeNull();
		expect(declaredDeviceSurface("")).toBeNull();
		expect(declaredDeviceSurface(null)).toBeNull();
		expect(declaredDeviceSurface(undefined)).toBeNull();
		expect(
			declaredDeviceSurface(`${"a".repeat(2001)} ryu:surface:desktop`)
		).toBeNull();
	});
});

describe("parseDeviceLimitRefusal", () => {
	test("reads a bare refusal body", () => {
		expect(parseDeviceLimitRefusal(REFUSAL)).toEqual({
			limit: 5,
			surface: "desktop",
		});
	});

	test("reads a Better Auth client error and a thrown APIError body", () => {
		expect(parseDeviceLimitRefusal({ data: null, error: REFUSAL })).toEqual({
			limit: 5,
			surface: "desktop",
		});
		expect(
			parseDeviceLimitRefusal({ body: REFUSAL, status: "FORBIDDEN" })
		).toEqual({ limit: 5, surface: "desktop" });
	});

	test("reads an RFC 8628 error alone and the bare codes", () => {
		expect(
			parseDeviceLimitRefusal({ error: DEVICE_LIMIT_REACHED_ERROR })
		).toEqual({ limit: null, surface: null });
		expect(parseDeviceLimitRefusal(DEVICE_LIMIT_REACHED_ERROR)).toEqual({
			limit: null,
			surface: null,
		});
		expect(parseDeviceLimitRefusal(DEVICE_LIMIT_REACHED_CODE)).toEqual({
			limit: null,
			surface: null,
		});
	});

	test("drops malformed limit and surface values", () => {
		expect(
			parseDeviceLimitRefusal({
				code: DEVICE_LIMIT_REACHED_CODE,
				limit: Number.NaN,
				surface: "toaster",
			})
		).toEqual({ limit: null, surface: null });
	});

	test("returns null for anything else", () => {
		expect(parseDeviceLimitRefusal(null)).toBeNull();
		expect(parseDeviceLimitRefusal("authorization_pending")).toBeNull();
		expect(
			parseDeviceLimitRefusal({ code: "BANNED_USER", message: "no" })
		).toBeNull();
		expect(
			parseDeviceLimitRefusal({ error: { code: "OTHER" }, status: 403 })
		).toBeNull();
	});
});
