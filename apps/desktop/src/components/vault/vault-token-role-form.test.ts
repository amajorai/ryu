import { expect, test } from "bun:test";
import {
	listField,
	type TokenRoleForm,
	tokenRoleForm,
	tokenRoleInput,
} from "./vault-token-role-form.ts";

function form(patch: Partial<TokenRoleForm>): TokenRoleForm {
	return { ...tokenRoleForm(null), name: "ci", ...patch };
}

test("a role round-trips through the form into the full replacement body", () => {
	const role = {
		allowedPolicies: ["ci-read", "ci-write"],
		boundCidrs: ["10.0.0.0/8"],
		createdAt: 1,
		disallowedPolicies: ["root"],
		maxTtlSecs: 86_400,
		name: "ci",
		numUses: 5,
		orphan: true,
		renewable: false,
		ttlSecs: 3600,
		updatedAt: 1,
	};
	expect(tokenRoleInput(tokenRoleForm(role))).toEqual({
		name: "ci",
		input: {
			allowedPolicies: ["ci-read", "ci-write"],
			disallowedPolicies: ["root"],
			boundCidrs: ["10.0.0.0/8"],
			maxTtlSecs: 86_400,
			numUses: 5,
			orphan: true,
			renewable: false,
			ttlSecs: 3600,
		},
	});
});

test("blank limits are left out and a new role is renewable", () => {
	expect(tokenRoleInput(form({ allowedPolicies: "a,\n b, a" }))).toEqual({
		name: "ci",
		input: {
			allowedPolicies: ["a", "b"],
			disallowedPolicies: [],
			orphan: false,
			renewable: true,
		},
	});
});

test("problems are reported before anything is sent", () => {
	const problem = (patch: Partial<TokenRoleForm>) => {
		const result = tokenRoleInput(form(patch));
		return "problem" in result ? result.problem : null;
	};
	expect(problem({ name: "CI role" })).toContain("lowercase");
	expect(problem({ ttl: "an hour" })).toContain("90s");
	expect(problem({ numUses: "-1" })).toContain("whole");
	expect(problem({ allowedPolicies: "x", disallowedPolicies: "x" })).toBe(
		"x is both allowed and disallowed."
	);
	expect(listField(" , ")).toEqual([]);
});
