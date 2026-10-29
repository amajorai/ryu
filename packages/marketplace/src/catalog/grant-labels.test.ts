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
		// The issued grant is camelCase; its table key must be stored lower-case.
		expect(grantLabel("chat.sendFollowUp")).toBe("Send follow-up messages");
	});

	test("the reviewed tool-plane grant has a curated label", () => {
		// Shipped apps hold `tools.invoke`; the enable dialog must not show the
		// humanized fallback "Tools invoke".
		expect(grantLabel("tools.invoke")).toBe("Use your connected tools");
		expect(grantDescription("tools.invoke")).toBe(
			"Run tools connected to Ryu and request work from Ryu-managed providers. Paid provider requests can use your Ryu credits."
		);
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
