import { describe, expect, test } from "bun:test";
import {
	accountAccessHeadline,
	accountAccessNote,
	accountKeyKind,
	accountKeyUnusedReason,
	addAccountKeys,
	identityModeDescription,
	parseAccountKey,
	parseAccountKeys,
	parseIdentityMode,
	removeAccountKeys,
	stepIdentityMode,
} from "./agentIdentity.ts";

describe("parseAccountKey mirrors Core's AccountKey::parse", () => {
	test.each([
		["composio:ca_123", "composio:ca_123"],
		["  provider:openai  ", "provider:openai"],
		["mcp:default:@ryu/notion:notion", "mcp:default:@ryu/notion:notion"],
		["mcp:p:plugin:with:colons:server", "mcp:p:plugin:with:colons:server"],
		["mcp-secret:github", "mcp-secret:github"],
		["platform:treg", "platform:treg"],
		["platform:desktop", "platform:desktop"],
		["agent:vault-1", "agent:vault-1"],
		["agent-composio:ca_9", "agent-composio:ca_9"],
	])("accepts %p", (raw, canonical) => {
		expect(parseAccountKey(raw)).toBe(canonical);
	});

	test.each([
		"",
		"openai",
		"provider:",
		"provider: openai",
		"platform:shell",
		"mcp:default:notion",
		"mcp::plugin:server",
		"mcp:profile::server",
		"mcp:profile:plugin:",
		"secret:x",
		"Provider:openai",
	])("refuses %p", (raw) => {
		expect(parseAccountKey(raw)).toBeNull();
	});

	test("parseAccountKeys reports every invalid entry and de-duplicates", () => {
		expect(
			parseAccountKeys(["provider:openai", "nope", "provider:openai", "x:"])
		).toEqual({ keys: ["provider:openai"], invalid: ["nope", "x:"] });
	});
});

describe("key kinds and the identity mode", () => {
	test("prefixes never confuse mcp with mcp-secret or agent with agent-composio", () => {
		expect(accountKeyKind("mcp-secret:github")?.label).toBe(
			"Services using your saved keys"
		);
		expect(accountKeyKind("mcp:a:b:c")?.label).toBe("MCP sign-ins");
		expect(accountKeyKind("agent-composio:ca")?.label).toBe(
			"Its own connected apps"
		);
		expect(accountKeyKind("agent:v")?.label).toBe("Its own logins");
		expect(accountKeyKind("bogus")).toBeNull();
	});

	test("your accounts are unused with only its own identity, its own unused when acting as you", () => {
		expect(accountKeyUnusedReason("provider:openai", "individual")).toContain(
			"its own identity"
		);
		expect(
			accountKeyUnusedReason("platform:desktop", "individual")
		).not.toBeNull();
		expect(accountKeyUnusedReason("agent:v", "managed")).toContain(
			"acts as you"
		);
		expect(accountKeyUnusedReason("platform:treg", "individual")).toBeNull();
		expect(accountKeyUnusedReason("provider:openai", "mixed")).toBeNull();
		expect(accountKeyUnusedReason("agent:v", "mixed")).toBeNull();
	});
});

describe("allowlist edits keep null and [] distinct", () => {
	test("adding to no limit narrows to Treg and the added keys", () => {
		expect(addAccountKeys(null, ["platform:treg"])).toEqual(["platform:treg"]);
		expect(addAccountKeys(null, ["provider:openai"])).toEqual([
			"platform:treg",
			"provider:openai",
		]);
		expect(addAccountKeys(["a:1"], ["a:1", "provider:x"])).toEqual([
			"a:1",
			"provider:x",
		]);
	});

	test("removing every key leaves an empty list, not no limit", () => {
		expect(removeAccountKeys(["provider:openai"], ["provider:openai"])).toEqual(
			[]
		);
	});

	test("headlines and notes", () => {
		expect(accountAccessHeadline(null)).toBe("No limit");
		expect(accountAccessHeadline([])).toBe("Limited: no accounts");
		expect(accountAccessHeadline(["platform:treg"])).toBe(
			"Limited to 1 account"
		);
		expect(accountAccessNote([], "managed")).toBe(
			"It can't use any accounts, or Treg."
		);
		// Only keys the mode can use count as usable.
		expect(accountAccessNote(["agent:v"], "managed")).toBe(
			"It can't use any accounts, or Treg."
		);
		expect(accountAccessNote(null, "individual")).toContain("never uses yours");
	});
});

describe("identity modes", () => {
	test("only the three wire values parse", () => {
		expect(parseIdentityMode("Individual")).toBe("individual");
		expect(parseIdentityMode(" mixed ")).toBe("mixed");
		expect(parseIdentityMode("owner")).toBeNull();
		expect(parseIdentityMode(null)).toBeNull();
	});

	test("arrow keys wrap around the three cards", () => {
		expect(stepIdentityMode("managed", -1)).toBe("mixed");
		expect(stepIdentityMode("mixed", 1)).toBe("managed");
		expect(stepIdentityMode("managed", 1)).toBe("individual");
	});

	test("descriptions match the desktop cards", () => {
		expect(identityModeDescription("managed")).toBe(
			"Works on your behalf with the accounts you've connected."
		);
		expect(identityModeDescription("individual")).toStartWith(
			"Gets its own accounts and logins, and never touches yours. Models Ryu routes"
		);
		expect(identityModeDescription("mixed")).toStartWith(
			"Has its own accounts, and can also use the ones of yours you allow."
		);
	});
});
