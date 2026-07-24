// Unit tests for buildTarget (core/target.ts) — the env→ApiTarget resolver that
// picks the running Core node the TUI talks to. RYU_CORE_URL overrides the default,
// RYU_CORE_TOKEN supplies an optional bearer (null when unset), and both are
// trimmed. Every test snapshots + restores the two env vars so ordering can't leak.
// DEFAULT_CORE_URL is frozen at import from RYU_PROFILE, so the tests assert
// buildTarget agrees with that imported constant rather than hard-coding a port.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildTarget, DEFAULT_CORE_URL } from "../core/target.ts";

let savedUrl: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
	savedUrl = process.env.RYU_CORE_URL;
	savedToken = process.env.RYU_CORE_TOKEN;
	// biome-ignore lint/performance/noDelete: must genuinely unset so the `?? DEFAULT` fallback path runs.
	delete process.env.RYU_CORE_URL;
	// biome-ignore lint/performance/noDelete: must genuinely unset so the `?? DEFAULT` fallback path runs.
	delete process.env.RYU_CORE_TOKEN;
});

afterEach(() => {
	if (savedUrl === undefined) {
		delete process.env.RYU_CORE_URL;
	} else {
		process.env.RYU_CORE_URL = savedUrl;
	}
	if (savedToken === undefined) {
		delete process.env.RYU_CORE_TOKEN;
	} else {
		process.env.RYU_CORE_TOKEN = savedToken;
	}
});

test("falls back to DEFAULT_CORE_URL with no token when nothing is set", () => {
	expect(buildTarget()).toEqual({ url: DEFAULT_CORE_URL, token: null });
});

test("RYU_CORE_URL overrides the default", () => {
	process.env.RYU_CORE_URL = "http://remote-node:9000";
	expect(buildTarget().url).toBe("http://remote-node:9000");
});

test("a blank/whitespace RYU_CORE_URL falls back to the default", () => {
	process.env.RYU_CORE_URL = "   ";
	expect(buildTarget().url).toBe(DEFAULT_CORE_URL);
});

test("RYU_CORE_URL is trimmed of surrounding whitespace", () => {
	process.env.RYU_CORE_URL = "  http://n:7980  ";
	expect(buildTarget().url).toBe("http://n:7980");
});

test("RYU_CORE_TOKEN populates the bearer token (trimmed)", () => {
	process.env.RYU_CORE_TOKEN = "  sekret  ";
	expect(buildTarget().token).toBe("sekret");
});

test("a blank RYU_CORE_TOKEN resolves to null (no bearer)", () => {
	process.env.RYU_CORE_TOKEN = "   ";
	expect(buildTarget().token).toBeNull();
});

test("DEFAULT_CORE_URL is a loopback Core address", () => {
	// Release :7980 or dev :8980 depending on the import-time RYU_PROFILE; either
	// way it must be a 127.0.0.1 loopback URL (never a remote host by default).
	expect(DEFAULT_CORE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});
