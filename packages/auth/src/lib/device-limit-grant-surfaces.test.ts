import { describe, expect, test } from "bun:test";
import {
	rememberGrantSurface,
	takeGrantSurface,
} from "./device-limit-grant-surfaces.ts";

describe("device grant surface hand-off", () => {
	test("a remembered surface is read once", () => {
		rememberGrantSurface("code-once", "mobile", 1000);
		expect(takeGrantSurface("code-once", 1001)).toBe("mobile");
		expect(takeGrantSurface("code-once", 1002)).toBeNull();
	});

	test("a remembered surface expires after two minutes", () => {
		rememberGrantSurface("code-stale", "desktop", 0);
		expect(takeGrantSurface("code-stale", 120_001)).toBeNull();
	});

	test("an unknown device code has no surface", () => {
		expect(takeGrantSurface("never-seen")).toBeNull();
	});
});
