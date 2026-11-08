import { afterEach, expect, test } from "bun:test";
import {
	type FakeCoreRequest,
	useFakeLoopbackCore,
} from "./__tests__/fake-loopback-core.ts";
import { CoreIdentityError, UnverifiableCoreError } from "./core-identity.ts";
import {
	brokerSessionIdentityProof,
	brokerSessionKey,
	brokerSessionLookupId,
	InsecureCoreUrlError,
	verifiedVaultAgentTarget,
} from "./core-identity-broker.ts";
import { vaultAgentBrokerDiscover } from "./vault.ts";

const NONCE = "0123456789abcdef".repeat(4);
let restore: (() => void) | null = null;

afterEach(() => {
	restore?.();
	restore = null;
});

test("pinned vectors match Core's", () => {
	// apps/core/src/vault/broker/session_identity.rs
	expect(brokerSessionLookupId("rvb_example")).toBe(
		"44a024002bf182a6d5de111fed8e49bc285336b160ae6a9aa0a460dfe8510c77"
	);
	// apps/core/src/server/core_identity.rs
	expect(
		brokerSessionIdentityProof("aa".repeat(32), "127.0.0.1", 7980, NONCE)
	).toBe("92c82b23a4ffc50312944cef5e29c249480a103dce905478d2f21eca4b585112");
	expect(brokerSessionKey("rvb_example")).toHaveLength(64);
});

test("a tokenless loopback Core is challenged with the session before it gets it", async () => {
	const seen: FakeCoreRequest[] = [];
	restore = useFakeLoopbackCore({ sessions: ["rvb_agent"], seen });
	const target = verifiedVaultAgentTarget(
		{ url: "http://127.0.0.1:7980", token: null },
		{ brokerSession: "rvb_agent" }
	);
	const discovery = await vaultAgentBrokerDiscover(target);
	expect(discovery.environment).toBe("dev");
	expect(seen.map((entry) => entry.path)).toEqual([
		"/api/health/identity",
		"/api/vault/agent/broker/discover",
	]);
	const [challenge, request] = seen;
	// The challenge names the session only by its lookup id, with no credential.
	expect(challenge?.query.get("broker_session")).toBe(
		brokerSessionLookupId("rvb_agent")
	);
	expect(challenge?.authorization).toBeNull();
	expect(challenge?.search).not.toContain("rvb_agent");
	// The session rides on the connection that passed the challenge.
	expect(request?.authorization).toBe("Bearer rvb_agent");
	expect(request?.connection).toBe(challenge?.connection);
	expect(request?.vaultToken).toBeNull();
});

test("a listener that cannot prove the session never receives it", async () => {
	const seen: FakeCoreRequest[] = [];
	restore = useFakeLoopbackCore({ sessions: ["rvb_other"], seen });
	const target = verifiedVaultAgentTarget(
		{ url: "http://localhost:7980", token: null },
		{ brokerSession: "rvb_agent" }
	);
	await expect(vaultAgentBrokerDiscover(target)).rejects.toBeInstanceOf(
		CoreIdentityError
	);
	expect(seen.every((entry) => entry.path === "/api/health/identity")).toBe(
		true
	);
	expect(seen.some((entry) => entry.authorization !== null)).toBe(false);
});

test("a node token, when present, verifies Core for a vault token", async () => {
	const seen: FakeCoreRequest[] = [];
	restore = useFakeLoopbackCore({ nodeToken: "node-secret", seen });
	const target = verifiedVaultAgentTarget(
		{ url: "http://127.0.0.1:7980", token: "node-secret" },
		{ vaultToken: "rvt_machine" }
	);
	await vaultAgentBrokerDiscover(target);
	const request = seen.at(-1);
	expect(request?.vaultToken).toBe("rvt_machine");
	expect(request?.authorization).toBeNull();
	expect(seen[0]?.query.get("broker_session")).toBeNull();
});

test("unverifiable targets fail closed before any request", () => {
	expect(() =>
		verifiedVaultAgentTarget(
			{ url: "http://127.0.0.1:7980", token: null },
			{ vaultToken: "rvt_machine" }
		)
	).toThrow(UnverifiableCoreError);
	for (const url of ["http://core.example.com:7980", "not a url"]) {
		expect(() =>
			verifiedVaultAgentTarget(
				{ url, token: "node-secret" },
				{ brokerSession: "rvb_agent" }
			)
		).toThrow(InsecureCoreUrlError);
	}
	// https keeps its TLS server authentication.
	expect(
		verifiedVaultAgentTarget(
			{ url: "https://core.example.com", token: null },
			{ vaultToken: "rvt_machine" }
		).vaultToken
	).toBe("rvt_machine");
});
