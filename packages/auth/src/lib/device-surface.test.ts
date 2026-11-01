import { describe, expect, test } from "bun:test";
import {
	classifyDeviceSurface,
	countSessionsBySurface,
	deviceGrantSurface,
	sessionCountsTowardDeviceLimit,
	sessionDeviceSurface,
} from "./device-surface.ts";

const NOW = new Date("2026-10-31T12:00:00Z");
const LIVE = new Date("2026-11-30T12:00:00Z");
const EXPIRED = new Date("2026-10-01T12:00:00Z");

describe("classifyDeviceSurface", () => {
	test("maps known device clients to their surfaces", () => {
		expect(classifyDeviceSurface({ clientId: "ryu-cli" })).toBe("cli");
		expect(classifyDeviceSurface({ clientId: "ryu-mcp" })).toBe("cli");
		expect(classifyDeviceSurface({ clientId: "ryu-extension" })).toBe(
			"extension"
		);
		expect(classifyDeviceSurface({ clientId: "ryu-mobile" })).toBe("mobile");
		expect(classifyDeviceSurface({ clientId: "ryu-web" })).toBe("web");
	});

	test("ryu-desktop honours a declared desktop, web, or self-hosted surface", () => {
		expect(
			classifyDeviceSurface({
				clientId: "ryu-desktop",
				declaredSurface: "desktop",
				origin: null,
			})
		).toBe("desktop");
		expect(
			classifyDeviceSurface({
				clientId: "ryu-desktop",
				declaredSurface: "self_hosted",
				origin: "tauri://localhost",
			})
		).toBe("self_hosted");
		// The hosted web app build runs the same flow and declares `web`, even
		// when the poll itself carries no Origin.
		expect(
			classifyDeviceSurface({
				clientId: "ryu-desktop",
				declaredSurface: "web",
				origin: null,
			})
		).toBe("web");
	});

	test("ryu-desktop ignores a declared surface it may not claim", () => {
		expect(
			classifyDeviceSurface({
				clientId: "ryu-desktop",
				declaredSurface: "cli",
				origin: null,
			})
		).toBe("self_hosted");
	});

	test("ryu-desktop falls back to the request Origin", () => {
		const desktop = (origin: string | null) =>
			classifyDeviceSurface({ clientId: "ryu-desktop", origin });
		expect(desktop(null)).toBe("self_hosted");
		expect(desktop("")).toBe("self_hosted");
		expect(desktop("null")).toBe("self_hosted");
		expect(desktop("tauri://localhost")).toBe("desktop");
		expect(desktop("http://tauri.localhost")).toBe("desktop");
		expect(desktop("https://app.ryu.ai")).toBe("web");
		expect(desktop("ryu-desktop://callback")).toBe("desktop");
	});

	test("an Expo origin is mobile and everything else is web", () => {
		expect(classifyDeviceSurface({ expoOrigin: "ryu://" })).toBe("mobile");
		expect(classifyDeviceSurface({ expoOrigin: "  " })).toBe("web");
		expect(classifyDeviceSurface({ clientId: "unknown-client" })).toBe("web");
		expect(classifyDeviceSurface({})).toBe("web");
	});

	test("a known client id wins over an Expo origin", () => {
		expect(
			classifyDeviceSurface({ clientId: "ryu-cli", expoOrigin: "ryu://" })
		).toBe("cli");
	});
});

describe("deviceGrantSurface", () => {
	test("an undeclared desktop grant counts as a Core runtime", () => {
		expect(deviceGrantSurface("ryu-desktop", null)).toBe("self_hosted");
		expect(deviceGrantSurface("ryu-desktop", "desktop")).toBe("desktop");
		expect(deviceGrantSurface("ryu-desktop", "web")).toBe("web");
		expect(deviceGrantSurface("ryu-extension", "desktop")).toBe("extension");
		expect(deviceGrantSurface(undefined, undefined)).toBe("web");
	});
});

describe("sessionDeviceSurface", () => {
	test("a stamped surface wins", () => {
		expect(
			sessionDeviceSurface({ issuedClientId: "ryu-cli", surface: "mobile" })
		).toBe("mobile");
	});

	test("an unknown stamped surface falls back to the legacy rule", () => {
		expect(
			sessionDeviceSurface({ issuedClientId: "ryu-cli", surface: "toaster" })
		).toBe("cli");
	});

	test("legacy desktop rows split on the user agent", () => {
		expect(sessionDeviceSurface({ issuedClientId: "ryu-desktop" })).toBe(
			"self_hosted"
		);
		expect(
			sessionDeviceSurface({
				issuedClientId: "ryu-desktop",
				userAgent: "Mozilla/5.0 Tauri",
			})
		).toBe("desktop");
	});

	test("legacy unmarked rows and junk are web", () => {
		expect(sessionDeviceSurface({ userAgent: "Mozilla/5.0" })).toBe("web");
		expect(sessionDeviceSurface(null)).toBe("web");
		expect(sessionDeviceSurface("session")).toBe("web");
	});
});

describe("sessionCountsTowardDeviceLimit", () => {
	test("only live, non-impersonated rows count", () => {
		expect(sessionCountsTowardDeviceLimit({ expiresAt: LIVE }, NOW)).toBe(true);
		expect(
			sessionCountsTowardDeviceLimit({ expiresAt: LIVE.toISOString() }, NOW)
		).toBe(true);
		expect(
			sessionCountsTowardDeviceLimit({ expiresAt: LIVE.getTime() }, NOW)
		).toBe(true);
		expect(sessionCountsTowardDeviceLimit({ expiresAt: EXPIRED }, NOW)).toBe(
			false
		);
		expect(
			sessionCountsTowardDeviceLimit(
				{ expiresAt: LIVE, impersonatedBy: "admin-1" },
				NOW
			)
		).toBe(false);
		expect(sessionCountsTowardDeviceLimit({}, NOW)).toBe(false);
		expect(sessionCountsTowardDeviceLimit({ expiresAt: "soon" }, NOW)).toBe(
			false
		);
		expect(sessionCountsTowardDeviceLimit(null, NOW)).toBe(false);
	});
});

describe("countSessionsBySurface", () => {
	test("counts live rows per surface and skips the rest", () => {
		const counts = countSessionsBySurface(
			[
				{ expiresAt: LIVE, surface: "web" },
				{ expiresAt: LIVE },
				{ expiresAt: LIVE, surface: "desktop" },
				{ expiresAt: LIVE, issuedClientId: "ryu-desktop" },
				{ expiresAt: LIVE, issuedClientId: "ryu-mcp" },
				{ expiresAt: EXPIRED, surface: "web" },
				{ expiresAt: LIVE, impersonatedBy: "support", surface: "web" },
				null,
			],
			NOW
		);
		expect(counts).toEqual({
			cli: 1,
			desktop: 1,
			extension: 0,
			mobile: 0,
			self_hosted: 1,
			web: 2,
		});
	});
});
