// Unit tests for the plain-English permission-grant vocabulary. Known grants map
// to a curated label/description; unknown grants humanize gracefully so the consent
// UI never shows a raw identifier like `hook:run-agent`.

import { describe, expect, test } from "bun:test";
import { grantDescription, grantLabel } from "./grant-labels.ts";

describe("grantLabel", () => {
	test("known grant returns its curated label", () => {
		expect(grantLabel("hook:run-agent")).toBe("Run AI agents");
		expect(grantLabel("storage:kv")).toBe("Store app data on this device");
	});

	test("lookup is case-insensitive", () => {
		expect(grantLabel("FS.READ")).toBe("Read your files");
	});

	test("unknown grant is humanized from its separators", () => {
		expect(grantLabel("foo:bar")).toBe("Foo bar");
		expect(grantLabel("some_weird-grant/name")).toBe("Some weird grant name");
	});

	test("empty string returns the raw value", () => {
		expect(grantLabel("")).toBe("");
	});

	test("separators-only grant returns the raw value", () => {
		expect(grantLabel(":::")).toBe(":::");
	});
});

describe("grantDescription", () => {
	test("known grant returns its description", () => {
		expect(grantDescription("net")).toBe("Make network requests.");
	});

	test("lookup is case-insensitive", () => {
		expect(grantDescription("Shell")).toBe(
			"Execute shell commands on this device."
		);
	});

	test("unknown grant returns null", () => {
		expect(grantDescription("foo:bar")).toBeNull();
	});
});
