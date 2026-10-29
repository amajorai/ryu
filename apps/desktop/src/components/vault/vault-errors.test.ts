import { describe, expect, test } from "bun:test";
import { sharedValuesMissingMessage } from "@/src/lib/access-refusal.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	isForbidden,
	isStaleVersion,
	isVaultStepUpRequired,
	readWithStepUp,
	type VaultStepUpGuard,
	vaultErrorMessage,
} from "./vault-errors.ts";

// The Vault pages decide what to render from these two answers: whether a
// failure is Core refusing the caller (the broker panel's "Broker admins only"
// branch hangs on it) and which sentence to show for it.

const FALLBACK = "Try again.";

test("a Core vault error shows its sentence without the program code, capitalised", () => {
	expect(
		vaultErrorMessage(
			new ApiError(
				"/api/vault/secrets",
				403,
				"vault_denied: the `read` capability is required on `default/API_KEY`"
			),
			FALLBACK
		)
	).toBe("The `read` capability is required on `default/API_KEY`");
	expect(
		vaultErrorMessage(
			new ApiError("/api/vault/seal", 423, "vault_sealed:   unseal it first"),
			FALLBACK
		)
	).toBe("Unseal it first");
});

test("only a leading vault_ code is stripped; other messages keep their text", () => {
	expect(
		vaultErrorMessage(
			new ApiError("/api/x", 500, "database vault_denied: stays"),
			FALLBACK
		)
	).toBe("Database vault_denied: stays");
	expect(
		vaultErrorMessage(new ApiError("/api/x", 429, "Slow down"), FALLBACK)
	).toBe("Slow down");
	expect(
		vaultErrorMessage(
			new ApiError("/api/x", 400, "VAULT_DENIED: loud"),
			FALLBACK
		)
	).toBe("VAULT_DENIED: loud");
});

test("an API failure with no server message says so for 403 and uses the fallback otherwise", () => {
	expect(vaultErrorMessage(new ApiError("/api/x", 403), FALLBACK)).toBe(
		"You do not have access to do that."
	);
	expect(vaultErrorMessage(new ApiError("/api/x", 500), FALLBACK)).toBe(
		FALLBACK
	);
	expect(vaultErrorMessage(new ApiError("/api/x", 409, ""), FALLBACK)).toBe(
		FALLBACK
	);
});

test("a thrown Error shows its own message, and anything else the fallback", () => {
	expect(vaultErrorMessage(new Error("network down"), FALLBACK)).toBe(
		"network down"
	);
	// An Error whose message was blanked has nothing to show.
	const blank = Object.assign(new Error("placeholder"), { message: "" });
	expect(vaultErrorMessage(blank, FALLBACK)).toBe(FALLBACK);
	expect(vaultErrorMessage("boom", FALLBACK)).toBe(FALLBACK);
	expect(vaultErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
	expect(vaultErrorMessage(null, FALLBACK)).toBe(FALLBACK);
});

test("isForbidden is true only for an API failure with status 403", () => {
	expect(isForbidden(new ApiError("/api/x", 403))).toBe(true);
	expect(isForbidden(new ApiError("/api/x", 403, "vault_denied: no"))).toBe(
		true
	);
	for (const status of [400, 401, 404, 409, 500, 503]) {
		expect(isForbidden(new ApiError("/api/x", status))).toBe(false);
	}
	// A look-alike that is not an ApiError never counts as a refusal.
	expect(isForbidden(Object.assign(new Error("denied"), { status: 403 }))).toBe(
		false
	);
	expect(isForbidden({ status: 403 })).toBe(false);
	expect(isForbidden(undefined)).toBe(false);
	expect(isForbidden(null)).toBe(false);
});

test("isStaleVersion is true only for an API failure with status 409", () => {
	expect(isStaleVersion(new ApiError("/api/x", 409))).toBe(true);
	expect(isStaleVersion(new ApiError("/api/x", 403))).toBe(false);
	expect(
		isStaleVersion(Object.assign(new Error("stale"), { status: 409 }))
	).toBe(false);
	expect(isStaleVersion(undefined)).toBe(false);
});

const stepUpRefusal = () =>
	new ApiError("/api/vault/secrets/API_KEY/reveal", 403, "Verify", undefined, {
		error: "STEP_UP_REQUIRED",
		scope: "org.credentials",
	});

/** A guard that records its scope and answers like a confirmed or dismissed prompt. */
function fakeGuard(confirmed: boolean) {
	const scopes: string[] = [];
	const guard: VaultStepUpGuard = async (scope, action) => {
		scopes.push(scope);
		return confirmed ? await action() : null;
	};
	return { guard, scopes };
}

describe("shared plaintext reads", () => {
	test("recognises only Core's pass-through of the step-up refusal", () => {
		expect(isVaultStepUpRequired(stepUpRefusal())).toBe(true);
		expect(
			isVaultStepUpRequired(
				new ApiError("/x", 403, "denied", undefined, { error: "denied" })
			)
		).toBe(false);
		expect(
			isVaultStepUpRequired(
				new ApiError("/x", 500, "x", undefined, { error: "STEP_UP_REQUIRED" })
			)
		).toBe(false);
		expect(isVaultStepUpRequired(new Error("STEP_UP_REQUIRED"))).toBe(false);
	});

	test("a read a node vouches for never prompts", async () => {
		const { guard, scopes } = fakeGuard(true);
		expect(await readWithStepUp(guard, async () => "s3cret")).toBe("s3cret");
		expect(scopes).toEqual([]);
	});

	test("a refused read confirms org.credentials and reads once more", async () => {
		const { guard, scopes } = fakeGuard(true);
		let reads = 0;
		const value = await readWithStepUp(guard, async () => {
			reads += 1;
			if (reads === 1) {
				throw stepUpRefusal();
			}
			return "s3cret";
		});
		expect(value).toBe("s3cret");
		expect(reads).toBe(2);
		expect(scopes).toEqual(["org.credentials"]);
	});

	test("a dismissed prompt reads nothing", async () => {
		const { guard } = fakeGuard(false);
		let reads = 0;
		const value = await readWithStepUp(guard, async () => {
			reads += 1;
			throw stepUpRefusal();
		});
		expect(value).toBeNull();
		expect(reads).toBe(1);
	});

	test("any other failure is not turned into a prompt", async () => {
		const { guard, scopes } = fakeGuard(true);
		const denied = new ApiError("/x", 403, "vault_denied: no", undefined, {
			error: "vault_denied: no",
		});
		await expect(
			readWithStepUp(guard, async () => {
				throw denied;
			})
		).rejects.toBe(denied);
		expect(scopes).toEqual([]);
	});
});

describe("vault error messages", () => {
	test("say what to do for a control-plane refusal instead of 'Unauthorized'", () => {
		const refused = new ApiError(
			"/api/vault/export",
			401,
			"Unauthorized",
			"user_jwt_org_not_admitted"
		);
		expect(vaultErrorMessage(refused, "Could not export.")).toContain(
			"ryu-cli secrets confirm CODE --method totp"
		);
		const plain = new ApiError("/api/vault/export", 401, "Unauthorized");
		expect(vaultErrorMessage(plain, "Could not export.")).toBe("Unauthorized");
	});
});

describe("an export that left the shared values out", () => {
	test("says what to do when the control plane refused you", () => {
		const refused = sharedValuesMissingMessage(
			"vault_shared_refused: org_ip_not_allowed"
		);
		expect(refused).toContain("Shared secrets were left out");
		expect(refused).toContain("network address");
		expect(refused).toContain("your own and this node's secrets only");
	});

	test("treats the account two-factor mandates as refusals, not outages", () => {
		// Core's `is_caller_refusal` exports with these codes too.
		for (const [code, phrase] of [
			["mfa_enrollment_required", "authenticator app or a passkey"],
			["staff_session_factor_required", "staff sign-ins"],
		] as const) {
			const message = sharedValuesMissingMessage(
				`vault_shared_refused: ${code}`
			);
			expect(message).toContain("Shared secrets were left out");
			expect(message).toContain(phrase);
		}
	});

	test("says they could not be loaded on an outage or an unknown code", () => {
		for (const sharedError of [
			"vault_shared_unreachable: the control plane answered 503",
			"vault_shared_refused: something_new",
		]) {
			expect(sharedValuesMissingMessage(sharedError)).toBe(
				"Shared secrets could not be loaded. This export has your own and this node's secrets only."
			);
		}
	});

	test("explains a change sent through a shared node", () => {
		expect(
			vaultErrorMessage(
				new ApiError(
					"/api/vault/secrets/API_KEY",
					403,
					"changes go through your own personal node or the web console",
					"personal_node_required"
				),
				"Could not save."
			)
		).toContain("your own personal node");
	});
});
