import { expect, test } from "bun:test";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	actionErrorDescription,
	isOrgAccessNotInSession,
	ORG_ACCESS_NOT_IN_SESSION_MESSAGE,
} from "./action-error.ts";

test("describes an Error by its message", () => {
	expect(actionErrorDescription(new Error("Core returned 500"))).toBe(
		"Core returned 500"
	);
});

test("describes a thrown string by its text", () => {
	expect(actionErrorDescription("  offline  ")).toBe("offline");
});

test("omits the description when the failure carries no message", () => {
	// biome-ignore lint/suspicious/useErrorMessage: a whitespace-only message is the case under test
	expect(actionErrorDescription(new Error("   "))).toBeUndefined();
	expect(actionErrorDescription(null)).toBeUndefined();
	expect(actionErrorDescription({ status: 500 })).toBeUndefined();
});

test("explains a sign-in that does not carry the node's organization", () => {
	const refused = new ApiError(
		"/api/agents",
		403,
		"Your sign-in does not include access to the organization this node belongs to.",
		"org_access_not_in_session"
	);
	expect(isOrgAccessNotInSession(refused)).toBe(true);
	expect(actionErrorDescription(refused)).toBe(
		ORG_ACCESS_NOT_IN_SESSION_MESSAGE
	);
	expect(ORG_ACCESS_NOT_IN_SESSION_MESSAGE).toContain(
		"ryu-cli secrets confirm CODE --method totp"
	);
	// A plain 403 keeps the error's own text.
	const plain = new ApiError("/api/agents", 403);
	expect(isOrgAccessNotInSession(plain)).toBe(false);
	expect(actionErrorDescription(plain)).toBe("/api/agents failed: 403");
});

test("explains the control plane's refusals of a forwarded request", () => {
	const refused = (status: number, code: string) =>
		actionErrorDescription(
			new ApiError(
				"/api/vault/secrets/API_KEY/reveal",
				status,
				"Unauthorized",
				code
			)
		);
	expect(refused(401, "user_jwt_org_not_admitted")).toContain(
		"ryu-cli secrets confirm CODE --method totp"
	);
	expect(refused(401, "user_jwt_session_ended")).toContain("sign in again");
	expect(refused(403, "not_an_org_member")).toBe(
		"You're not a member of this node's organization."
	);
	expect(refused(503, "user_jwt_lookup_unavailable")).toContain(
		"Try again shortly"
	);
	// An unknown code keeps the error's own text.
	expect(refused(401, "something_else")).toBe(
		"/api/vault/secrets/API_KEY/reveal failed: 401"
	);
});
