import { describe, expect, it } from "bun:test";
import {
	defaultPermissionsForRole,
	intersectStatements,
	OIDC_STANDARD_SCOPES,
	RYU_CAPABILITIES,
	RYU_OAUTH_SCOPES,
	RYU_SUPPORTED_SCOPES,
	type RyuStatements,
	scopesToStatements,
	statementsToScopes,
} from "./scopes.ts";

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

describe("RYU_SUPPORTED_SCOPES", () => {
	it("is the standard OIDC scopes followed by the ryu capability scopes", () => {
		expect(RYU_SUPPORTED_SCOPES).toEqual([
			...OIDC_STANDARD_SCOPES,
			...RYU_OAUTH_SCOPES,
		]);
	});
});

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
			files: ["read", "write"],
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

	it("treats an absent/legacy role the same as a normal user", () => {
		expect(defaultPermissionsForRole(null)).toEqual(
			defaultPermissionsForRole("user")
		);
		expect(defaultPermissionsForRole(undefined)).toEqual(
			defaultPermissionsForRole("user")
		);
	});
});
