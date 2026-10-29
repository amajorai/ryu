import { describe, expect, test } from "bun:test";
import {
	isAgentOwnedKey,
	pausedTriggerIds,
	savedModeHasOwnApps,
	triggerAllowedByAccess,
} from "./agent-account-keys.ts";

const yours = { connectedAccountId: "ca_1", id: "t_yours", ownAccount: false };
const own = { connectedAccountId: "own_1", id: "t_own", ownAccount: true };

describe("isAgentOwnedKey", () => {
	test("matches Core's agent-owned keys only", () => {
		expect(isAgentOwnedKey("agent:acct")).toBe(true);
		expect(isAgentOwnedKey("agent-composio:own_1")).toBe(true);
		expect(isAgentOwnedKey("composio:ca_1")).toBe(false);
		expect(isAgentOwnedKey("platform:treg")).toBe(false);
		expect(isAgentOwnedKey("mcp-secret:@ryu/exa")).toBe(false);
	});
});

describe("triggerAllowedByAccess", () => {
	test("an unrestricted agent acting as you keeps triggers on your accounts only", () => {
		expect(triggerAllowedByAccess("managed", null, yours)).toBe(true);
		// Core never delivers own-entity events to an agent acting as you.
		expect(triggerAllowedByAccess("managed", null, own)).toBe(false);
	});

	test("its own identity never receives events from your accounts", () => {
		expect(triggerAllowedByAccess("individual", null, yours)).toBe(false);
		expect(triggerAllowedByAccess("individual", ["composio:ca_1"], yours)).toBe(
			false
		);
		expect(triggerAllowedByAccess("individual", null, own)).toBe(true);
	});

	test("a limit needs the account's own row", () => {
		expect(triggerAllowedByAccess("mixed", ["composio:ca_1"], yours)).toBe(
			true
		);
		expect(triggerAllowedByAccess("mixed", ["composio:ca_1"], own)).toBe(false);
		expect(triggerAllowedByAccess("mixed", ["agent-composio:own_1"], own)).toBe(
			true
		);
		// The row for the other kind does not count.
		expect(triggerAllowedByAccess("mixed", ["composio:own_1"], own)).toBe(
			false
		);
		expect(triggerAllowedByAccess("managed", [], yours)).toBe(false);
	});
});

describe("pausedTriggerIds", () => {
	test("lists the triggers the access would stop", () => {
		expect(pausedTriggerIds("individual", null, [yours, own])).toEqual([
			"t_yours",
		]);
		expect(pausedTriggerIds("mixed", null, [yours, own])).toEqual([]);
		expect(pausedTriggerIds("mixed", [], [yours, own])).toEqual([
			"t_yours",
			"t_own",
		]);
	});
});

describe("savedModeHasOwnApps", () => {
	test("only an agent saved with its own identity holds apps of its own", () => {
		expect(savedModeHasOwnApps("individual")).toBe(true);
		expect(savedModeHasOwnApps("mixed")).toBe(true);
		expect(savedModeHasOwnApps("managed")).toBe(false);
		expect(savedModeHasOwnApps(null)).toBe(false);
		expect(savedModeHasOwnApps(undefined)).toBe(false);
	});
});
