// apps/desktop/src/lib/api/acp-authenticate.test.ts
//
// The response shapes are Core's `acp_authenticate` replies. Without a
// provider to verify against, Core answers an accepted login with
// `verificationRequired`, which the UI must not report as a failed sign-in.

import { describe, expect, test } from "bun:test";
import { acpAuthAwaitsVerification, authenticateAgent } from "./acp.ts";

const target = {
	token: "test-node",
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

async function authenticateWith(body: unknown) {
	const originalFetch = globalThis.fetch;
	Reflect.set(globalThis, "fetch", async () => Response.json(body));
	try {
		return await authenticateAgent(target, "acp:claude", "claude-login");
	} finally {
		Reflect.set(globalThis, "fetch", originalFetch);
	}
}

describe("authenticateAgent outcomes", () => {
	test("an accepted but unverifiable login awaits verification", async () => {
		const result = await authenticateWith({
			authenticated: false,
			agentAccepted: true,
			verified: false,
			verificationRequired: true,
			code: "auth_verification_required",
			error: "The agent accepted the authentication request.",
		});
		expect(result.verificationRequired).toBe(true);
		expect(result.code).toBe("auth_verification_required");
		expect(acpAuthAwaitsVerification(result)).toBe(true);
	});

	test("a verified sign-in, a rejection, and a native-account handoff do not", async () => {
		const verified = await authenticateWith({
			authenticated: true,
			agentAccepted: true,
			verified: true,
			changed: true,
		});
		const noCredential = await authenticateWith({
			authenticated: false,
			agentAccepted: true,
			verified: true,
			error: "no credential was stored",
		});
		const native = await authenticateWith({
			authenticated: false,
			verified: false,
			nativeAccounts: true,
			code: "native_account_login_required",
		});
		expect(acpAuthAwaitsVerification(verified)).toBe(false);
		expect(acpAuthAwaitsVerification(noCredential)).toBe(false);
		expect(acpAuthAwaitsVerification(native)).toBe(false);
		expect(native.nativeAccounts).toBe(true);
	});
});
