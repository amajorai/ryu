// humanizeError turns raw transport/schema failures into one readable line; the
// raw socket code and zod's JSON issue dump must never reach a frame.

import { expect, test } from "bun:test";
import { ApiError } from "@ryuhq/core-client/client";
import { z } from "zod";
import {
	accessRefusalHint,
	displayHostPort,
	humanizeError,
	isOrgAccessNotInSession,
	nativeErrorMessage,
	ORG_ACCESS_NOT_IN_SESSION_HINT,
	sharedRefusalCode,
} from "../core/native-errors.ts";

const CORE_URL = "http://127.0.0.1:7980";

function connectionRefused(): Error {
	return Object.assign(
		new Error("Unable to connect. Is the computer able to access the url?"),
		{ code: "ConnectionRefused", path: `${CORE_URL}/api/agents` }
	);
}

test("connection failures name the node instead of the socket code", () => {
	expect(humanizeError(connectionRefused(), { url: CORE_URL })).toBe(
		"Core isn't reachable at 127.0.0.1:7980"
	);
	// Without ctx it falls back to the URL Bun records on the error.
	expect(humanizeError(connectionRefused())).toBe(
		"Core isn't reachable at 127.0.0.1:7980"
	);
	expect(
		humanizeError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))
	).toBe("Core isn't reachable");
	expect(
		humanizeError("TypeError: fetch failed", { url: "https://node.example" })
	).toBe("Core isn't reachable at node.example");
	const abort = new Error("The operation was aborted.");
	abort.name = "AbortError";
	expect(humanizeError(abort, { url: CORE_URL })).toBe(
		"Core isn't reachable at 127.0.0.1:7980"
	);
});

test("zod errors and serialized issue arrays name the first bad field", () => {
	const parsed = z
		.object({ agents: z.array(z.object({ id: z.string() })) })
		.safeParse({ agents: [{ id: 7 }] });
	expect(parsed.success).toBe(false);
	const zodError = parsed.error;
	const fromError = humanizeError(zodError);
	expect(fromError).toStartWith(
		"Core returned an unexpected response (agents.0.id: "
	);
	expect(fromError).not.toContain("[{");

	// A plain Error whose message is the JSON issue array (zod's .message).
	const fromMessage = humanizeError(new Error(zodError?.message));
	expect(fromMessage).toBe(fromError);
});

test("401 and 403 explain sign-in and permission", () => {
	expect(humanizeError(new Error("/api/agents failed: 401"))).toContain(
		"sign in"
	);
	expect(
		humanizeError(Object.assign(new Error("denied"), { status: 403 }))
	).toContain("permission");
});

test("a sign-in without the node's organization says how to get it back", () => {
	const refused = new ApiError(
		"/api/agents",
		403,
		"Your sign-in does not include access to the organization this node belongs to.",
		"org_access_not_in_session"
	);
	expect(isOrgAccessNotInSession(refused)).toBe(true);
	const line = humanizeError(refused);
	expect(line).toBe(ORG_ACCESS_NOT_IN_SESSION_HINT);
	expect(line).toContain("ryu-cli secrets confirm CODE --method totp");
	expect(line).toContain("passkey");
	// A plain 403, or the same code on another status, keeps its usual line.
	expect(isOrgAccessNotInSession(new ApiError("/api/agents", 403))).toBe(false);
	expect(
		isOrgAccessNotInSession(
			new ApiError("/api/agents", 401, undefined, "org_access_not_in_session")
		)
	).toBe(false);
});

test("the control plane's refusals of a forwarded request say what to do", () => {
	// Core passes these through as `{ code, error: "Unauthorized" }`, which
	// core-client reads into `ApiError.code`.
	const refusal = (status: number, code: string) =>
		humanizeError(
			new ApiError("/api/vault/export", status, "Unauthorized", code)
		);
	const notAdmitted = refusal(401, "user_jwt_org_not_admitted");
	expect(notAdmitted).toContain("ryu-cli secrets confirm CODE --method totp");
	expect(notAdmitted).not.toContain("(401)");
	expect(refusal(403, "org_mfa_session_required")).toContain(
		"ryu-cli secrets confirm CODE --method totp"
	);
	expect(refusal(401, "user_jwt_session_ended")).toContain("ryu-cli login");
	expect(refusal(403, "org_ip_not_allowed")).toContain("network address");
	expect(refusal(403, "not_an_org_member")).toBe(
		"You're not a member of this node's organization."
	);
	expect(refusal(403, "personal_node_required")).toContain(
		"your own personal node"
	);
	// A token the control plane did not accept is re-minted by Core first.
	expect(refusal(401, "user_jwt_invalid")).toContain("try again in a minute");
	expect(refusal(503, "user_jwt_lookup_unavailable")).toContain(
		"Try again shortly"
	);
	// An unknown code keeps the usual status line.
	expect(refusal(401, "something_else")).toBe(
		"Core needs you to sign in again (401) - open Settings → Account"
	);
});

test("an export's sharedError names the control plane's refusal code", () => {
	expect(sharedRefusalCode("vault_shared_refused: org_ip_not_allowed")).toBe(
		"org_ip_not_allowed"
	);
	expect(
		sharedRefusalCode(
			"vault_shared_unreachable: the control plane answered 503"
		)
	).toBeNull();
	expect(sharedRefusalCode("vault_shared_refused: ")).toBeNull();
});

test("every code Core treats as a caller refusal has a hint", () => {
	// `is_caller_refusal` in apps/core/src/server/vault_api.rs: these reach
	// the CLI as an export's `sharedError` or a reveal's `{ code }`.
	for (const code of [
		"mfa_enrollment_required",
		"staff_session_factor_required",
		"node_proxy_required",
		"personal_node_required",
		"not_an_org_member",
		"user_jwt_invalid",
		"user_jwt_session_ended",
		"user_jwt_org_not_admitted",
		"user_jwt_lookup_unavailable",
		"org_ip_not_allowed",
		"org_mfa_required",
		"org_mfa_session_required",
		"org_session_expired",
	]) {
		expect(accessRefusalHint({ code })?.code).toBe(code);
	}
	expect(
		accessRefusalHint({ code: "mfa_enrollment_required" })?.hint
	).toContain("authenticator app or a passkey");
	expect(
		accessRefusalHint({ code: "staff_session_factor_required" })?.hint
	).toContain("`ryu-cli logout`");
});

test("other errors keep their raw message", () => {
	expect(humanizeError(new Error("agent not found"))).toBe("agent not found");
	expect(humanizeError("plain text")).toBe("plain text");
	expect(humanizeError(new Error("[not json"))).toBe("[not json");
	// nativeErrorMessage itself is unchanged.
	expect(nativeErrorMessage(connectionRefused())).toBe(
		"Unable to connect. Is the computer able to access the url?"
	);
});

test("humanized text is stable when humanized again", () => {
	const once = humanizeError(connectionRefused(), { url: CORE_URL });
	expect(humanizeError(once, { url: CORE_URL })).toBe(once);
	const signIn = humanizeError(new Error("/api/x failed: 401"));
	expect(humanizeError(signIn)).toBe(signIn);
});

test("displayHostPort strips scheme and path", () => {
	expect(displayHostPort("http://127.0.0.1:7980/api")).toBe("127.0.0.1:7980");
	expect(displayHostPort("not a url")).toBe("not a url");
});
