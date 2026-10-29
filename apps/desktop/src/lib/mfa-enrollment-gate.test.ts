import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	mfaEnrollmentClearKeyForUser,
	readMfaEnrollmentClear,
	rememberMfaEnrollmentAccess,
	resolveMfaEnrollmentSurface,
} from "./mfa-enrollment-gate.ts";

beforeAll(() => {
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register();
	}
});

afterEach(() => {
	localStorage.clear();
});

describe("second-factor gate surface", () => {
	test("a required account gets the enrollment screen, even over an older clear", () => {
		expect(
			resolveMfaEnrollmentSurface({
				access: "required",
				cachedClear: false,
				enabled: true,
			})
		).toBe("enroll");
		expect(
			resolveMfaEnrollmentSurface({
				access: "required",
				cachedClear: true,
				enabled: true,
			})
		).toBe("enroll");
	});

	test("clear, exempt and unknown all open the app", () => {
		for (const access of ["clear", "exempt", "unknown"] as const) {
			expect(
				resolveMfaEnrollmentSurface({
					access,
					cachedClear: false,
					enabled: true,
				})
			).toBe("app");
		}
	});

	test("anonymous and signed-out use is never gated", () => {
		expect(
			resolveMfaEnrollmentSurface({
				access: null,
				cachedClear: false,
				enabled: false,
			})
		).toBe("app");
		expect(
			resolveMfaEnrollmentSurface({
				access: "required",
				cachedClear: false,
				enabled: false,
			})
		).toBe("app");
	});

	test("the first read holds the app back unless this account was clear before", () => {
		expect(
			resolveMfaEnrollmentSurface({
				access: null,
				cachedClear: false,
				enabled: true,
			})
		).toBe("loading");
		expect(
			resolveMfaEnrollmentSurface({
				access: null,
				cachedClear: true,
				enabled: true,
			})
		).toBe("app");
	});
});

describe("per-account clear marker", () => {
	test("follows definite answers and ignores unknown", () => {
		rememberMfaEnrollmentAccess("user-a", "clear");
		expect(readMfaEnrollmentClear("user-a")).toBe(true);
		rememberMfaEnrollmentAccess("user-a", "unknown");
		expect(readMfaEnrollmentClear("user-a")).toBe(true);
		rememberMfaEnrollmentAccess("user-a", "required");
		expect(readMfaEnrollmentClear("user-a")).toBe(false);
	});

	test("an exempt answer never leaves a clear marker behind", () => {
		rememberMfaEnrollmentAccess("user-a", "clear");
		rememberMfaEnrollmentAccess("user-a", "exempt");
		expect(readMfaEnrollmentClear("user-a")).toBe(false);
	});

	test("is scoped per account and needs a known account", () => {
		rememberMfaEnrollmentAccess("user-a", "clear");
		expect(readMfaEnrollmentClear("user-b")).toBe(false);
		expect(mfaEnrollmentClearKeyForUser("user-a")).not.toBe(
			mfaEnrollmentClearKeyForUser("user-b")
		);
		rememberMfaEnrollmentAccess(null, "clear");
		expect(readMfaEnrollmentClear(null)).toBe(false);
	});
});
