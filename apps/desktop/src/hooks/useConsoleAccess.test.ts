import { describe, expect, test } from "bun:test";
import {
	CONSOLE_PERMISSION,
	canAccessConsoleForNode,
} from "./useConsoleAccess.ts";

describe("Console product access", () => {
	test("does not require a Ryu organization for self-hosted nodes", () => {
		expect(
			canAccessConsoleForNode({
				managed: false,
				orgId: null,
				permissions: undefined,
				settled: false,
			})
		).toBe(true);
	});

	test("requires settled permissions for the managed node organization", () => {
		expect(
			canAccessConsoleForNode({
				managed: true,
				orgId: "org-cloud",
				permissions: [CONSOLE_PERMISSION],
				settled: false,
			})
		).toBe(false);
		expect(
			canAccessConsoleForNode({
				managed: true,
				orgId: null,
				permissions: [CONSOLE_PERMISSION],
				settled: true,
			})
		).toBe(false);
	});

	test("refuses members whose effective permissions lack node configuration", () => {
		expect(
			canAccessConsoleForNode({
				managed: true,
				orgId: "org-cloud",
				permissions: ["gateway.view", "agent.run", "space.write"],
				settled: true,
			})
		).toBe(false);
	});

	test("admits any caller granted node configuration, including custom roles", () => {
		expect(
			canAccessConsoleForNode({
				managed: true,
				orgId: "org-cloud",
				permissions: ["agent.run", CONSOLE_PERMISSION],
				settled: true,
			})
		).toBe(true);
	});
});
