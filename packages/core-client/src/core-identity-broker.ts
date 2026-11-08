// Verify Core before an agent hands it its vault token or broker session.
//
// An agent Ryu starts through the credential broker usually holds only its
// `rvb_` session: Core injects the proxy, NO_PROXY and CA variables into the
// agent, never the node token. A plain-HTTP loopback port proves nothing about
// who listens on it, so before such an agent sends the session to Core it runs
// the identity challenge keyed by the session instead of the node token. Core
// stores only `K = sha256_hex(session)`; the agent sends the one-way lookup id
// `sha256_hex("ryu-broker-session-lookup-v1:" + K)` with the nonce and expects
// `HMAC-SHA256(K, "ryu-core-identity-broker-v1:<address>:<port>:<nonce>")`
// (Core's `vault/broker/session_identity.rs` and `server/core_identity.rs`).
// A squatter that sees the lookup id cannot recover `K`, so it cannot answer.
//
// `verifiedVaultAgentTarget` is the one policy the CLI and ryu-mcp share for
// the agent routes: https is left to TLS; a remote plain-HTTP address is
// refused (nothing authenticates it); a loopback address is challenged with
// the node token when the caller has one, else with the broker session, and a
// vault token without a node token is refused (`UnverifiableCoreError`).
//
// NODE-ONLY: the challenge opens its own sockets (`./loopback-connection.ts`).

import { createHash, createHmac } from "node:crypto";
import type { ApiTarget } from "./client.ts";
import {
	type IdentityChallengeKey,
	identityGatedFetch,
	isPlainHttpLoopback,
	rawFetchForTarget,
	socketAddressText,
	UnverifiableCoreError,
	withCoreIdentityCheck,
} from "./core-identity.ts";
import type { VaultAgentTarget } from "./vault.ts";
import { brokerSessionTarget } from "./vault-broker-agent.ts";

const LOOKUP_DOMAIN = "ryu-broker-session-lookup-v1";
const BROKER_IDENTITY_DOMAIN = "ryu-core-identity-broker-v1";

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The key Core stores for `session` (its `token_hash`). */
export function brokerSessionKey(session: string): string {
	return sha256Hex(session);
}

/** The lookup id an agent sends to name `session` without revealing its key. */
export function brokerSessionLookupId(session: string): string {
	return sha256Hex(`${LOOKUP_DOMAIN}:${brokerSessionKey(session)}`);
}

/** The proof Core gives for `nonce` on a connection accepted on `address:port`. */
export function brokerSessionIdentityProof(
	sessionKey: string,
	address: string,
	port: number,
	nonce: string
): string {
	return createHmac("sha256", sessionKey)
		.update(
			`${BROKER_IDENTITY_DOMAIN}:${socketAddressText(address, port)}:${nonce}`
		)
		.digest("hex");
}

/** The identity challenge keyed by a broker session. */
export function brokerSessionChallenge(session: string): IdentityChallengeKey {
	const key = brokerSessionKey(session);
	return {
		query: `&broker_session=${brokerSessionLookupId(session)}`,
		prove: (address, port, nonce) =>
			brokerSessionIdentityProof(key, address, port, nonce),
	};
}

/** Thrown before an agent credential is sent to a remote plain-HTTP address. */
export class InsecureCoreUrlError extends Error {
	constructor(url: string) {
		super(
			`${url} is a remote http:// address, so nothing proves the process answering there is your Ryu Core; the agent credential was not sent. Reach the node over https://, or run on the same machine.`
		);
		this.name = "InsecureCoreUrlError";
	}
}

/** What an agent authenticates to Core with. Never a credential value. */
export type VaultAgentCredential =
	| { brokerSession: string }
	| { vaultToken: string };

function isRemotePlainHttp(url: string): boolean {
	try {
		return new URL(url).protocol === "http:" && !isPlainHttpLoopback(url);
	} catch {
		return true;
	}
}

function withSession(session: string): (request: Request) => Request {
	return (request) => {
		const sessioned = new Request(request);
		sessioned.headers.set("Authorization", `Bearer ${session}`);
		return sessioned;
	};
}

/**
 * The agent target for `core` that sends `credential` only to a listener that
 * proved it is Core (see the module comment). Throws `UnverifiableCoreError`
 * or `InsecureCoreUrlError` instead of sending it anywhere else.
 */
export function verifiedVaultAgentTarget(
	core: Pick<ApiTarget, "fetch" | "url"> & { token?: string | null },
	credential: VaultAgentCredential
): VaultAgentTarget {
	if (isRemotePlainHttp(core.url)) {
		throw new InsecureCoreUrlError(core.url);
	}
	const inner = rawFetchForTarget(core);
	if (!isPlainHttpLoopback(core.url)) {
		return "vaultToken" in credential
			? { url: core.url, fetch: inner, vaultToken: credential.vaultToken }
			: brokerSessionTarget(
					{ url: core.url, fetch: inner },
					credential.brokerSession
				);
	}
	if (core.token) {
		const { fetch } = withCoreIdentityCheck({
			url: core.url,
			token: core.token,
			fetch: inner,
		});
		return "vaultToken" in credential
			? { url: core.url, fetch, vaultToken: credential.vaultToken }
			: brokerSessionTarget({ url: core.url, fetch }, credential.brokerSession);
	}
	if ("vaultToken" in credential) {
		throw new UnverifiableCoreError(core.url);
	}
	const session = credential.brokerSession;
	return {
		url: core.url,
		// An empty vault token sends no `x-ryu-vault-token`, so Core reads the
		// session from `Authorization`.
		vaultToken: "",
		fetch: identityGatedFetch(
			core.url,
			brokerSessionChallenge(session),
			inner,
			withSession(session)
		),
	};
}
