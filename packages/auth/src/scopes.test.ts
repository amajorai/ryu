import { describe, expect, it } from "bun:test";
import {
	accessLevelOptions,
	accessLevelsFromScopes,
	accessLevelsToScopes,
	defaultAuthorizeScopes,
	defaultPermissionsForRole,
	findUnknownOAuthScopes,
	fullAccessLevels,
	HOSTED_ONLY_RESOURCES,
	implicitPermissionsForRole,
	intersectOAuthScopes,
	intersectStatements,
	NO_ACCESS,
	OAUTH_OPT_IN_SCOPES,
	OIDC_STANDARD_SCOPES,
	parseOAuthScopes,
	permissionsForPersonalToken,
	RYU_CAPABILITIES,
	RYU_DEFAULT_OAUTH_SCOPES,
	RYU_MCP_HOSTED_SCOPES,
	RYU_MCP_OAUTH_SCOPES,
	RYU_OAUTH_SCOPES,
	RYU_SUPPORTED_SCOPES,
	type RyuStatements,
	readOnlyAccessLevels,
	scopesToStatements,
	statementsToScopes,
	withoutOptInScopes,
} from "./scopes.ts";

describe("OAuth scope boundary helpers", () => {
	it("parses array and wire-format scope values without duplicates", () => {
		expect(parseOAuthScopes("tools:read  tools:exec tools:read")).toEqual([
			"tools:read",
			"tools:exec",
		]);
		expect(parseOAuthScopes(["chat:read", 7, " chat:write "])).toEqual([
			"chat:read",
			"chat:write",
		]);
	});

	it("identifies unknown scopes instead of silently widening", () => {
		expect(
			findUnknownOAuthScopes(["openid", "tools:read", "root:all"])
		).toEqual(["root:all"]);
	});

	it("intersects requested capabilities and strips OIDC scopes", () => {
		expect(
			intersectOAuthScopes(
				["openid", "tools:read", "tools:exec"],
				["tools:exec", "files:write"]
			)
		).toEqual(["tools:exec"]);
		expect(intersectOAuthScopes(["openid", "chat:read"])).toEqual([
			"chat:read",
		]);
	});

	it("deduplicates repeated requested capabilities", () => {
		expect(
			intersectOAuthScopes(
				["tools:read", "tools:exec"],
				["tools:read", "tools:read", "tools:exec"]
			)
		).toEqual(["tools:read", "tools:exec"]);
	});
});

describe("RYU_OAUTH_SCOPES derivation", () => {
	it("flattens every capability action into resource:action strings", () => {
		const expectedCount = Object.values(RYU_CAPABILITIES).reduce(
			(sum, actions) => sum + actions.length,
			0
		);
		expect(RYU_OAUTH_SCOPES.length).toBe(expectedCount);
		expect(RYU_OAUTH_SCOPES).toContain("chat:read");
		expect(RYU_OAUTH_SCOPES).toContain("agents:manage");
		expect(RYU_OAUTH_SCOPES).toContain("gateway:route");
		expect(RYU_OAUTH_SCOPES).toContain("vault:write");
	});

	it("never contains an OIDC standard scope", () => {
		for (const std of OIDC_STANDARD_SCOPES) {
			expect(RYU_OAUTH_SCOPES).not.toContain(std);
		}
	});

	it("has no duplicate scope strings", () => {
		expect(new Set(RYU_OAUTH_SCOPES).size).toBe(RYU_OAUTH_SCOPES.length);
	});
});

describe("hosted-only resources", () => {
	it("models Ryu Messaging as a read and manage capability", () => {
		expect(RYU_CAPABILITIES.messaging).toEqual(["read", "manage"]);
		expect(RYU_OAUTH_SCOPES).toContain("messaging:read");
		expect(RYU_OAUTH_SCOPES).toContain("messaging:manage");
		expect(scopesToStatements(["messaging:manage", "messaging:send"])).toEqual({
			messaging: ["manage"],
		});
	});

	it("lists Messaging, Mail and Prompts as the hosted-only resources", () => {
		expect(HOSTED_ONLY_RESOURCES).toEqual(["messaging", "mail", "prompts"]);
	});

	it("models the prompt registry as read and manage, API-key only", () => {
		expect(RYU_CAPABILITIES.prompts).toEqual(["read", "manage"]);
		expect(RYU_OAUTH_SCOPES).toContain("prompts:read");
		expect(RYU_OAUTH_SCOPES).toContain("prompts:manage");
		expect(accessLevelsToScopes({ prompts: "manage" })).toEqual([
			"prompts:read",
			"prompts:manage",
		]);
		// No OAuth (MCP) client may request a prompt scope.
		expect(RYU_SUPPORTED_SCOPES).not.toContain("prompts:read");
		expect(RYU_SUPPORTED_SCOPES).not.toContain("prompts:manage");
		expect(accessLevelOptions("prompts").map((option) => option.label)).toEqual(
			["No access", "Read", "Read, commit & manage prompts"]
		);
	});

	it("models hosted Mail as cumulative read, send and manage levels", () => {
		expect(RYU_CAPABILITIES.mail).toEqual(["read", "send", "manage"]);
		for (const scope of ["mail:read", "mail:send", "mail:manage"]) {
			expect(RYU_OAUTH_SCOPES).toContain(scope);
		}
		expect(accessLevelsToScopes({ mail: "send" })).toEqual([
			"mail:read",
			"mail:send",
		]);
		expect(accessLevelsToScopes({ mail: "manage" })).toEqual([
			"mail:read",
			"mail:send",
			"mail:manage",
		]);
		expect(scopesToStatements(["mail:send", "mail:admin"])).toEqual({
			mail: ["send"],
		});
	});
});

describe("RYU_SUPPORTED_SCOPES", () => {
	it("is the standard OIDC scopes followed by the OAuth-grantable capability scopes", () => {
		expect(RYU_SUPPORTED_SCOPES).toEqual([
			...OIDC_STANDARD_SCOPES,
			...RYU_MCP_OAUTH_SCOPES,
		]);
	});

	it("advertises only the hosted scopes hosted MCP honours", () => {
		const hostedOnly = new Set<string>(HOSTED_ONLY_RESOURCES);
		const advertised = RYU_SUPPORTED_SCOPES.filter((scope) =>
			hostedOnly.has(scope.split(":")[0] ?? "")
		);
		expect(advertised).toEqual(["mail:read", "mail:send", "mail:manage"]);
		expect(RYU_MCP_HOSTED_SCOPES).toEqual([
			"mail:read",
			"mail:send",
			"mail:manage",
		]);
		// Every Messaging scope stays API-key only.
		expect(RYU_SUPPORTED_SCOPES).not.toContain("messaging:read");
		expect(RYU_SUPPORTED_SCOPES).not.toContain("messaging:manage");
		// API keys keep the full vocabulary.
		expect(RYU_OAUTH_SCOPES).toContain("mail:manage");
		expect(RYU_MCP_OAUTH_SCOPES).toEqual(
			RYU_OAUTH_SCOPES.filter(
				(scope) =>
					RYU_MCP_HOSTED_SCOPES.includes(scope) || !advertisedHostedOnly(scope)
			)
		);
	});

	it("advertises mail:manage but never grants it by default", () => {
		expect(OAUTH_OPT_IN_SCOPES).toEqual(["mail:manage"]);
		expect(RYU_SUPPORTED_SCOPES).toContain("mail:manage");
		// A client registered without `scope` gets every other supported scope.
		expect(RYU_DEFAULT_OAUTH_SCOPES).toEqual(
			RYU_SUPPORTED_SCOPES.filter((scope) => scope !== "mail:manage")
		);
		expect(RYU_DEFAULT_OAUTH_SCOPES).toContain("mail:send");
		// An authorize request without `scope` never asks for it, whether the
		// client registered for it or has no scopes on record.
		expect(defaultAuthorizeScopes(null)).toEqual(RYU_DEFAULT_OAUTH_SCOPES);
		expect(
			defaultAuthorizeScopes(["openid", "mail:read", "mail:manage"])
		).toEqual(["openid", "mail:read"]);
		expect(defaultAuthorizeScopes(["mail:manage"])).toEqual([]);
	});

	it("advertises every node scope", () => {
		for (const scope of RYU_OAUTH_SCOPES.filter(
			(candidate) => !advertisedHostedOnly(candidate)
		)) {
			expect(RYU_SUPPORTED_SCOPES).toContain(scope);
		}
	});

	it("still recognises a hosted-only scope on a stored grant", () => {
		expect(findUnknownOAuthScopes(["mail:read", "messaging:read"])).toEqual([]);
		expect(findUnknownOAuthScopes(["mail:teleport"])).toEqual([
			"mail:teleport",
		]);
	});
});

function advertisedHostedOnly(scope: string): boolean {
	return (HOSTED_ONLY_RESOURCES as readonly string[]).includes(
		scope.split(":")[0] ?? ""
	);
}

describe("scopesToStatements", () => {
	it("groups known scopes by resource", () => {
		const out = scopesToStatements([
			"chat:read",
			"chat:write",
			"agents:manage",
		]);
		expect(out).toEqual({
			chat: ["read", "write"],
			agents: ["manage"],
		});
	});

	it("drops unknown resources and unknown actions (cannot widen a key)", () => {
		const out = scopesToStatements([
			"chat:read",
			"bogus:read", // unknown resource
			"chat:destroy", // unknown action on a known resource
			"agents:write", // agents only supports read/manage
		]);
		expect(out).toEqual({ chat: ["read"] });
	});

	it("ignores malformed scope strings without a resource:action shape", () => {
		const out = scopesToStatements(["chat", "chat:", ":read", ""]);
		expect(out).toEqual({});
	});

	it("returns an empty map for an empty input", () => {
		expect(scopesToStatements([])).toEqual({});
	});

	it("round-trips through statementsToScopes for valid input", () => {
		const scopes = ["chat:read", "chat:write", "tools:exec"];
		const back = statementsToScopes(scopesToStatements(scopes));
		expect(new Set(back)).toEqual(new Set(scopes));
	});
});

describe("statementsToScopes", () => {
	it("flattens a statement map to resource:action strings", () => {
		const scopes = statementsToScopes({
			chat: ["read", "write"],
			gateway: ["route"],
		});
		expect(scopes).toEqual(["chat:read", "chat:write", "gateway:route"]);
	});

	it("returns an empty array for null or undefined", () => {
		expect(statementsToScopes(null)).toEqual([]);
		expect(statementsToScopes(undefined)).toEqual([]);
	});
});

describe("intersectStatements", () => {
	it("keeps only resources and actions the ceiling also grants", () => {
		const requested: RyuStatements = {
			chat: ["read", "write"],
			agents: ["read", "manage"],
			files: ["write"],
		};
		const ceiling: RyuStatements = {
			chat: ["read", "write"],
			agents: ["read"], // narrower than requested
			// files absent from ceiling
		};
		expect(intersectStatements(requested, ceiling)).toEqual({
			chat: ["read", "write"],
			agents: ["read"],
		});
	});

	it("drops a resource entirely when no requested action is permitted", () => {
		const out = intersectStatements(
			{ agents: ["manage"] },
			{ agents: ["read"] }
		);
		expect(out).toEqual({});
	});

	it("returns an empty map when nothing intersects", () => {
		expect(
			intersectStatements({ chat: ["read"] }, { files: ["read"] })
		).toEqual({});
	});
});

describe("defaultPermissionsForRole", () => {
	it("grants an admin every capability action", () => {
		const perms = defaultPermissionsForRole("admin");
		expect(perms).toEqual({
			chat: ["read", "write"],
			agents: ["read", "manage"],
			workflows: ["read", "run", "manage"],
			tools: ["read", "exec"],
			memory: ["read", "write"],
			gateway: ["route"],
			vault: ["write"],
			files: ["read", "write"],
			messaging: ["read", "manage"],
			mail: ["read", "send", "manage"],
			prompts: ["read", "manage"],
		});
	});

	it("gives a waitlisted user read-only, omitting resources without a read action", () => {
		const perms = defaultPermissionsForRole("waitlist");
		expect(perms).toEqual({
			chat: ["read"],
			agents: ["read"],
			workflows: ["read"],
			tools: ["read"],
			memory: ["read"],
			files: ["read"],
			messaging: ["read"],
			mail: ["read"],
			prompts: ["read"],
		});
		// gateway only supports "route" (no "read") so it is excluded entirely.
		expect(perms.gateway).toBeUndefined();
	});

	it("gives a normal user read+write but never destructive manage", () => {
		const perms = defaultPermissionsForRole("user");
		expect(perms.agents).toEqual(["read"]);
		expect(perms.workflows).toEqual(["read", "run"]);
		expect(perms.workflows).not.toContain("manage");
	});

	it("lets a normal user's key send messages, leaving the spend to org RBAC", () => {
		expect(defaultPermissionsForRole("user").messaging).toEqual([
			"read",
			"manage",
		]);
	});

	it("lets a normal user choose Mail manage but never grants it implicitly", () => {
		expect(defaultPermissionsForRole("user").mail).toEqual([
			"read",
			"send",
			"manage",
		]);
		expect(implicitPermissionsForRole("user").mail).toEqual(["read", "send"]);
		expect(implicitPermissionsForRole("admin").mail).toEqual(["read", "send"]);
		expect(implicitPermissionsForRole("waitlist").mail).toEqual(["read"]);
		const {
			mail: _mail,
			prompts: _prompts,
			...rest
		} = implicitPermissionsForRole("user");
		const {
			mail: _ceilingMail,
			prompts: _ceilingPrompts,
			...ceilingRest
		} = defaultPermissionsForRole("user");
		expect(rest).toEqual(ceilingRest);
		expect(withoutOptInScopes({ mail: ["manage"], chat: ["read"] })).toEqual({
			chat: ["read"],
		});
	});

	it("lets a normal user choose prompts manage but never grants it implicitly", () => {
		expect(defaultPermissionsForRole("user").prompts).toEqual([
			"read",
			"manage",
		]);
		expect(implicitPermissionsForRole("user").prompts).toEqual(["read"]);
		expect(implicitPermissionsForRole("admin").prompts).toEqual(["read"]);
		expect(
			withoutOptInScopes({ prompts: ["read", "manage"], chat: ["read"] })
		).toEqual({ prompts: ["read"], chat: ["read"] });
	});

	it("treats an absent/legacy role the same as a normal user", () => {
		expect(defaultPermissionsForRole(null)).toEqual(
			defaultPermissionsForRole("user")
		);
		expect(defaultPermissionsForRole(undefined)).toEqual(
			defaultPermissionsForRole("user")
		);
	});
});

describe("permissionsForPersonalToken", () => {
	it("gives a classic token the role ceiling minus opt-in-only scopes", () => {
		const classic = permissionsForPersonalToken({
			ceiling: defaultPermissionsForRole("user"),
			scopes: [],
			tokenType: "classic",
		});
		expect(classic).toEqual(implicitPermissionsForRole("user"));
		expect(classic.mail).toEqual(["read", "send"]);
	});

	it("lets a fine-grained token opt in to mail:manage within the ceiling", () => {
		expect(
			permissionsForPersonalToken({
				ceiling: defaultPermissionsForRole("user"),
				scopes: ["mail:read", "mail:send", "mail:manage"],
				tokenType: "fine-grained",
			})
		).toEqual({ mail: ["read", "send", "manage"] });
	});

	it("keeps fine-grained tokens inside the role ceiling", () => {
		expect(
			permissionsForPersonalToken({
				ceiling: defaultPermissionsForRole("user"),
				scopes: ["chat:write", "agents:manage", "files:read"],
				tokenType: "fine-grained",
			})
		).toEqual({
			chat: ["write"],
			files: ["read"],
		});
	});
});

describe("access levels (fine-grained token picker)", () => {
	it("expands a level cumulatively, so write implies read", () => {
		expect(
			accessLevelsToScopes({ chat: "write", workflows: "run", gateway: "none" })
		).toEqual(["chat:read", "chat:write", "workflows:read", "workflows:run"]);
	});

	it("round-trips scopes back to the highest level held", () => {
		const levels = accessLevelsFromScopes([
			"memory:read",
			"tools:read",
			"tools:exec",
		]);
		expect(levels.memory).toBe("read");
		expect(levels.tools).toBe("exec");
		expect(levels.chat).toBe(NO_ACCESS);
	});

	it("offers No access first and labels single-action resources plainly", () => {
		expect(accessLevelOptions("chat").map((option) => option.label)).toEqual([
			"No access",
			"Read",
			"Read & write",
		]);
		expect(accessLevelOptions("gateway").map((option) => option.label)).toEqual(
			["No access", "Route requests"]
		);
	});

	it("says what a messaging manage key can do instead of Admin", () => {
		expect(accessLevelOptions("messaging")).toEqual([
			{ value: NO_ACCESS, label: "No access" },
			{ value: "read", label: "Read" },
			{ value: "manage", label: "Read, send & manage numbers" },
		]);
	});

	it("labels the Mail levels by what each one can do", () => {
		expect(accessLevelOptions("mail")).toEqual([
			{ value: NO_ACCESS, label: "No access" },
			{ value: "read", label: "Read" },
			{ value: "send", label: "Read & send" },
			{ value: "manage", label: "Read, send & manage inboxes" },
		]);
	});

	it("presets grant everything or read only, and only known scopes", () => {
		const resources = ["chat", "gateway", "workflows"] as const;
		expect(accessLevelsToScopes(fullAccessLevels(resources))).toEqual([
			"chat:read",
			"chat:write",
			"workflows:read",
			"workflows:run",
			"workflows:manage",
			"gateway:route",
		]);
		expect(accessLevelsToScopes(readOnlyAccessLevels(resources))).toEqual([
			"chat:read",
			"workflows:read",
		]);
		for (const scope of accessLevelsToScopes(fullAccessLevels(resources))) {
			expect(RYU_OAUTH_SCOPES).toContain(scope);
		}
	});
});
