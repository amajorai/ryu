// Authenticate a plain-HTTP loopback Core before the CLI hands it a node bearer.
//
// A loopback port proves nothing about who is listening: another local account
// can claim Core's port while Core is stopped and answer `/api/health` itself.
// Plain HTTP has no server identity, so the CLI sends Core a fresh nonce with no
// credential and checks the answer against
// `HMAC-SHA256(node token, "ryu-core-identity-v2:<address>:<port>:<nonce>")`
// (`<address>:<port>` written like `127.0.0.1:7980` or `[::1]:7980`), which only
// a process that already holds the token can compute (Core's
// `server/core_identity.rs`). Core answers for the local address of the
// connection the challenge arrived on, and the CLI checks it against the
// literal address it dialed, so a squatter on another loopback address or port
// cannot relay the challenge to a real Core and pass. The CLI never dials a
// host name for such a target (`localhost` is tried as `127.0.0.1`, then
// `::1`), and it sends the credentialed request on the same TCP connection that
// passed the challenge (`loopbackConnection.ts`), so the port cannot change
// hands between the check and the request. A loopback target with no node
// token has nothing to verify with, so it never sends a credential. HTTPS
// targets keep their TLS server authentication and are left alone.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type ApiTarget,
	BUYER_TOKEN_HEADER,
	fetchForTarget,
	type RyuFetch,
	USER_JWT_HEADER,
} from "@ryuhq/core-client/client";
import { VAULT_TOKEN_HEADER } from "@ryuhq/core-client/vault";
import { z } from "zod";
import {
	dialLoopback,
	type LoopbackConnection,
	type LoopbackConnector,
} from "./loopbackConnection.ts";

export const CORE_IDENTITY_PATH = "/api/health/identity";
const IDENTITY_DOMAIN = "ryu-core-identity-v2";
const IDENTITY_TIMEOUT_MS = 5000;
const IDENTITY_BODY_LIMIT = 4096;
const PROOF_HEX = /^[0-9a-f]{64}$/u;
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;
const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;
/** Names (and unspecified addresses) that reach this machine's loopback. */
const LOOPBACK_NAMES = new Set(["localhost", "0.0.0.0", "::"]);
/** What a loopback name is dialed as, in order. Core binds 127.0.0.1 by default. */
const LOOPBACK_NAME_ADDRESSES = ["127.0.0.1", "::1"] as const;

const identityResponseSchema = z.object({ proof: z.string() });

/** `verified`: the listener proved it holds the token. `unreachable`: nothing
 *  answered. `mismatch`: something answered but could not prove it is Core. */
export type CoreIdentityVerdict = "verified" | "unreachable" | "mismatch";

/**
 * Why a listener can fail the challenge, and what to do. The proof is keyed by
 * this Core's own node token and the local address and port its connection was
 * accepted on, so a paired-device or delegated token, or a port forward that
 * lands on another address or port, fails the same way a relaying squatter
 * does: the CLI cannot tell them apart and fails closed.
 */
export const CORE_IDENTITY_CONFLICT_HINT =
	"Another program may be using this port; stop it, or update Ryu Core if it is an older version. The check also fails when the saved token is not this Core's own node token (for example a paired-device or delegated token), and when the address is a port forward that does not reach Core on the same loopback address and port number (forward to the same address and port, such as 127.0.0.1:7980, instead)";

/**
 * Thrown before a machine credential (`RYU_VAULT_TOKEN`, an AppRole secret, a
 * wrapping token) or a trust anchor (the broker CA) is exchanged with a local
 * plain-HTTP address that carries no node token: without the token there is
 * nothing to check the listener with, so its answers cannot be trusted either.
 */
export class UnverifiableCoreError extends Error {
	constructor(url: string) {
		super(
			`${url} is a local http:// address, and without this Core's node token the CLI cannot check that the process answering there is your Ryu Core, so it did not send it your vault credentials or use its answers. Set RYU_CORE_TOKEN to the Core's node token, or reach the node over https://`
		);
		this.name = "UnverifiableCoreError";
	}
}

/** Thrown instead of sending credentials to an unverified listener. */
export class CoreIdentityError extends Error {
	constructor(url: string) {
		super(
			`The process answering at ${url} could not prove it is your Ryu Core, so the CLI did not send it your token. ${CORE_IDENTITY_CONFLICT_HINT}.`
		);
		this.name = "CoreIdentityError";
	}
}

function parseUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

function ipv4FromMapped(bare: string): string | null {
	const match = IPV4_MAPPED.exec(bare);
	if (!(match?.[1] && match[2])) {
		return null;
	}
	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * The literal addresses to dial for a loopback URL host name, in order, or an
 * empty list when it is not loopback. A name such as `localhost` is never
 * handed to the resolver: the CLI must know the exact address it reaches,
 * because that is what Core's proof is bound to.
 */
export function loopbackAddresses(hostname: string): readonly string[] {
	const bare = hostname
		.toLowerCase()
		.replace(/^\[(.*)\]$/u, "$1")
		.replace(/\.$/u, "");
	if (IPV4_LOOPBACK.test(bare) || bare === "::1") {
		return [bare];
	}
	const mapped = ipv4FromMapped(bare);
	if (mapped !== null) {
		return IPV4_LOOPBACK.test(mapped) ? [mapped] : [];
	}
	if (LOOPBACK_NAMES.has(bare) || bare.endsWith(".localhost")) {
		return LOOPBACK_NAME_ADDRESSES;
	}
	return [];
}

function isLoopbackHost(hostname: string): boolean {
	return loopbackAddresses(hostname).length > 0;
}

/** The listening port a URL names, defaulting by scheme. */
function urlPort(url: URL): number {
	if (url.port) {
		return Number(url.port);
	}
	return url.protocol === "https:" ? 443 : 80;
}

/** A plain-HTTP loopback URL: any local account could be the listener. */
export function isPlainHttpLoopback(url: string): boolean {
	const parsed = parseUrl(url);
	return parsed?.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

/** Plain-HTTP loopback targets carrying a node token must prove Core's identity. */
export function requiresCoreIdentity(
	target: Pick<ApiTarget, "token" | "url">
): boolean {
	return Boolean(target.token) && isPlainHttpLoopback(target.url);
}

/** `address:port` as Core writes its local socket address. */
function socketAddressText(address: string, port: number): string {
	return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * The proof Core returns for `nonce` on a connection it accepted on the
 * literal `address` and `port`.
 */
export function coreIdentityProof(
	nodeToken: string,
	address: string,
	port: number,
	nonce: string
): string {
	return createHmac("sha256", nodeToken)
		.update(`${IDENTITY_DOMAIN}:${socketAddressText(address, port)}:${nonce}`)
		.digest("hex");
}

function sameProof(actual: string, expected: string): boolean {
	const normalized = actual.trim().toLowerCase();
	if (!PROOF_HEX.test(normalized)) {
		return false;
	}
	return timingSafeEqual(
		Buffer.from(normalized, "hex"),
		Buffer.from(expected, "hex")
	);
}

let connector: LoopbackConnector = dialLoopback;

/**
 * Test seam: replace how the CLI opens loopback connections (`null` restores
 * real sockets). Production code never calls this.
 */
export function setLoopbackConnectorForTests(
	next: LoopbackConnector | null
): void {
	connector = next ?? dialLoopback;
}

async function readCapped(response: Response, limit: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		return "";
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new TypeError("identity response too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Challenge the listener on an open `connection`; sends no credential. */
async function challenge(
	connection: LoopbackConnection,
	token: string,
	url: URL,
	signal: AbortSignal
): Promise<CoreIdentityVerdict> {
	const nonce = randomBytes(32).toString("hex");
	let response: Response;
	try {
		response = await connection.send(
			new Request(`${url.origin}${CORE_IDENTITY_PATH}?nonce=${nonce}`, {
				headers: { accept: "application/json" },
			}),
			{ close: false, signal }
		);
	} catch {
		return "unreachable";
	}
	let body: unknown;
	try {
		const text = await readCapped(response, IDENTITY_BODY_LIMIT);
		if (!response.ok) {
			return "mismatch";
		}
		body = JSON.parse(text);
	} catch {
		return "mismatch";
	}
	const parsed = identityResponseSchema.safeParse(body);
	if (!parsed.success) {
		return "mismatch";
	}
	const expected = coreIdentityProof(
		token,
		connection.address,
		connection.port,
		nonce
	);
	if (!sameProof(parsed.data.proof, expected)) {
		return "mismatch";
	}
	// A Core that is shutting down answers with `Connection: close`. The proof
	// only covers this connection, so the request it gates cannot go anywhere
	// else; whoever answers a new connection must pass its own challenge.
	return connection.open ? "verified" : "unreachable";
}

/**
 * Dial each literal address `target.url` names and challenge it. Returns the
 * first connection whose listener proved it holds the token, still open and
 * idle, so the caller's credentialed request rides on that same connection.
 * Every other connection is closed. Sends no credential.
 */
export async function openVerifiedCoreConnection(
	target: Pick<ApiTarget, "token" | "url">,
	signal: AbortSignal
): Promise<LoopbackConnection | Exclude<CoreIdentityVerdict, "verified">> {
	const url = parseUrl(target.url);
	if (!(url && target.token && url.protocol === "http:")) {
		return "mismatch";
	}
	let verdict: Exclude<CoreIdentityVerdict, "verified"> = "unreachable";
	for (const address of loopbackAddresses(url.hostname)) {
		if (signal.aborted) {
			break;
		}
		let connection: LoopbackConnection;
		try {
			connection = await connector(address, urlPort(url), signal);
		} catch {
			continue;
		}
		const result = await challenge(connection, target.token, url, signal);
		if (result === "verified") {
			return connection;
		}
		connection.close();
		if (result === "mismatch") {
			verdict = "mismatch";
		}
	}
	return verdict;
}

/**
 * Challenge the listener at `target.url` with a fresh nonce and close the
 * connection. Sends no credential.
 */
export async function verifyCoreIdentity(
	target: Pick<ApiTarget, "token" | "url">,
	signal: AbortSignal = AbortSignal.timeout(IDENTITY_TIMEOUT_MS)
): Promise<CoreIdentityVerdict> {
	const opened = await openVerifiedCoreConnection(target, signal);
	if (typeof opened === "string") {
		return opened;
	}
	opened.close();
	return "verified";
}

const rawFetches = new WeakMap<RyuFetch, RyuFetch>();

/** The transport underneath a verifying wrapper (or the target's own). */
export function rawFetchForTarget(target: Pick<ApiTarget, "fetch">): RyuFetch {
	const fetcher = fetchForTarget(target);
	return rawFetches.get(fetcher) ?? fetcher;
}

/**
 * Every header that carries a credential the CLI (or a client it embeds) can
 * send to Core: the node bearer, the user JWT, a vault machine token (ours and
 * the HashiCorp-compatible one), the control-plane buyer session, the node
 * token's alternate header, and cookies or proxy credentials.
 */
const CREDENTIAL_HEADERS = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"x-ryu-node-token",
	"x-vault-token",
	BUYER_TOKEN_HEADER,
	USER_JWT_HEADER,
	VAULT_TOKEN_HEADER,
] as const;

function stripCredentials(headers: HeadersInit | undefined): Headers {
	const stripped = new Headers(headers);
	for (const name of CREDENTIAL_HEADERS) {
		stripped.delete(name);
	}
	return stripped;
}

/**
 * A transport that sends none of {@link CREDENTIAL_HEADERS} (no bearer, user
 * JWT or vault token), whatever the caller put in the headers. `inner` defaults to the global fetch, resolved per request.
 */
export function withoutCredentials(inner?: RyuFetch): RyuFetch {
	const send: RyuFetch = (input, init) =>
		(inner ?? globalThis.fetch)(input, init);
	const anonymous: RyuFetch = (input, init) => {
		if (input instanceof Request) {
			// Delete from a copy rather than passing stripped headers as `init`:
			// Bun treats an empty `init.headers` as absent and keeps the input
			// Request's own headers, credentials included.
			const request = new Request(input, init);
			for (const name of CREDENTIAL_HEADERS) {
				request.headers.delete(name);
			}
			return send(request);
		}
		return send(input, { ...init, headers: stripCredentials(init?.headers) });
	};
	rawFetches.set(anonymous, send);
	return anonymous;
}

/**
 * Gate every request to a plain-HTTP loopback target behind Core's identity.
 * A target carrying a node token runs a fresh challenge before EACH request,
 * on a new connection to a literal loopback address, and sends the request on
 * that same connection only once the challenge has passed. No verdict is
 * cached and no connection is reused: the port can change hands whenever Core
 * stops (quit, crash, self-update), so a stream reconnect or the next poll
 * must not ride on an earlier proof. The target's own `fetch` is not used for
 * these requests, and redirects are returned rather than followed. A request
 * for another origin gets no credentials. A target without a node token cannot
 * be verified, so its requests carry neither a bearer nor a user JWT.
 */
export function withCoreIdentityCheck<T extends ApiTarget>(target: T): T {
	if (!isPlainHttpLoopback(target.url)) {
		return target;
	}
	const inner = rawFetchForTarget(target);
	const anonymous = withoutCredentials(inner);
	if (!requiresCoreIdentity(target)) {
		return { ...target, fetch: anonymous };
	}
	const origin = new URL(target.url).origin;
	const gated: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== origin) {
			return anonymous(input, init);
		}
		const challengeSignal = AbortSignal.any([
			request.signal,
			AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
		]);
		const opened = await openVerifiedCoreConnection(target, challengeSignal);
		if (request.signal.aborted) {
			if (typeof opened !== "string") {
				opened.close();
			}
			throw request.signal.reason;
		}
		if (opened === "unreachable") {
			throw new TypeError(`Ryu Core is not reachable at ${target.url}`);
		}
		if (opened === "mismatch") {
			throw new CoreIdentityError(target.url);
		}
		return opened.send(request, { close: true, signal: request.signal });
	};
	rawFetches.set(gated, inner);
	return { ...target, fetch: gated };
}
