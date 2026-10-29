// Loopback peer proof for Island's Shadow client: the TypeScript twin of
// `crates/core/sidecar-runtime/src/peer_proof.rs`. Keep the two in lockstep.
//
// Binding 127.0.0.1:<port> proves nothing about who is listening. Any local
// process can take Shadow's port while Shadow is down and answer the
// unauthenticated `/health` with 200; a client that then sends
// `Authorization: Bearer <token>` has handed the shared secret to it. So Island
// first sends a fresh 256-bit challenge to `/health?challenge=<challenge>`, and
// a genuine Shadow answers `proof = hex(HMAC-SHA256(token, DOMAIN || challenge))`.
// Island recomputes it, compares in constant time, and only then attaches the
// bearer. The proof reveals nothing about the token, and an unpredictable
// challenge cannot be answered ahead of time by a process that queried the real
// Shadow earlier.

import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

/** Query parameter that carries the client's challenge on the health route. */
export const CHALLENGE_QUERY_PARAM = "challenge";

/** Domain-separation prefix, byte-identical to the Rust `DOMAIN`. */
const PROOF_DOMAIN = "ryu-loopback-peer-proof-v1\0";

const MIN_CHALLENGE_LENGTH = 32;
const MAX_CHALLENGE_LENGTH = 128;
const CHALLENGE_ALPHABET = /^[A-Za-z0-9_-]+$/;
const TRAILING_SLASHES = /\/+$/;

/** Largest health body read; an endless reply from a squatter is cut off. */
const MAX_HEALTH_BODY_BYTES = 4 * 1024;

/** The probe answers fast or not at all; a hostile listener cannot stall it. */
const PROBE_TIMEOUT_MS = 2000;

const healthProofSchema = z.object({ proof: z.string() });

/** Whether `challenge` is 32 to 128 ASCII letters, digits, `-` or `_`. */
export function isValidChallenge(challenge: string): boolean {
	return (
		challenge.length >= MIN_CHALLENGE_LENGTH &&
		challenge.length <= MAX_CHALLENGE_LENGTH &&
		CHALLENGE_ALPHABET.test(challenge)
	);
}

/** A fresh, unpredictable challenge: 64 hex characters from the OS CSPRNG. */
export function newChallenge(): string {
	return randomBytes(32).toString("hex");
}

/**
 * The proof a holder of `token` gives for `challenge`, or `null` for an empty
 * token or a malformed challenge (fail closed, like the Rust `proof`).
 */
export function peerProof(token: string, challenge: string): string | null {
	if (!(token && isValidChallenge(challenge))) {
		return null;
	}
	return createHmac("sha256", token)
		.update(PROOF_DOMAIN)
		.update(challenge)
		.digest("hex");
}

/** Whether `provided` is the proof for `token` and `challenge`, in constant time. */
export function verifyPeerProof(
	token: string,
	challenge: string,
	provided: string
): boolean {
	const expected = peerProof(token, challenge);
	if (expected === null) {
		return false;
	}
	const expectedBytes = Buffer.from(expected, "utf8");
	const providedBytes = Buffer.from(provided.trim().toLowerCase(), "utf8");
	// The expected length is public (always 64), so this early exit leaks nothing.
	if (expectedBytes.length !== providedBytes.length) {
		return false;
	}
	return timingSafeEqual(expectedBytes, providedBytes);
}

/** What answered on the health route (mirrors the Rust `PeerProbe`). */
export type PeerProbe = "proven" | "no-proof" | "wrong-proof" | "unreachable";

/** Read at most `limit` bytes of `response`; `null` when it is longer. */
async function readCappedText(
	response: Response,
	limit: number
): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) {
		return "";
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function proofFromHealthBody(body: string): string | null {
	try {
		const parsed = healthProofSchema.safeParse(JSON.parse(body));
		return parsed.success ? parsed.data.proof : null;
	} catch {
		return null;
	}
}

/**
 * Challenge `<baseUrl>/health`. Never sends `token`; it is only used to check
 * the proof. No redirects are followed and the probe times out quickly.
 */
export async function probePeer(
	baseUrl: string,
	token: string,
	fetchImpl: typeof fetch = fetch
): Promise<PeerProbe> {
	const challenge = newChallenge();
	const url = `${baseUrl.replace(TRAILING_SLASHES, "")}/health?${CHALLENGE_QUERY_PARAM}=${challenge}`;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch {
		return "unreachable";
	}
	if (!response.ok) {
		await response.body?.cancel();
		return "unreachable";
	}
	let body: string | null;
	try {
		body = await readCappedText(response, MAX_HEALTH_BODY_BYTES);
	} catch {
		return "no-proof";
	}
	const provided = body === null ? null : proofFromHealthBody(body);
	if (provided === null) {
		return "no-proof";
	}
	return verifyPeerProof(token, challenge, provided) ? "proven" : "wrong-proof";
}

function tokenDigest(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

/**
 * Remembers one recent successful proof so a burst of requests (the poll loop,
 * a read-then-write) does not re-challenge Shadow each time. Keyed by origin
 * and a digest of the token, so a new origin or a rotated token re-challenges.
 * Only successes are cached; a failure clears the entry.
 */
export class PeerProofCache {
	private entry: {
		origin: string;
		tokenDigest: Buffer;
		provenAt: number;
	} | null = null;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(ttlMs: number, now: () => number = Date.now) {
		this.ttlMs = ttlMs;
		this.now = now;
	}

	isFresh(origin: string, token: string): boolean {
		const entry = this.entry;
		if (!entry || entry.origin !== origin) {
			return false;
		}
		return (
			timingSafeEqual(entry.tokenDigest, tokenDigest(token)) &&
			this.now() - entry.provenAt < this.ttlMs
		);
	}

	remember(origin: string, token: string): void {
		this.entry = {
			origin,
			tokenDigest: tokenDigest(token),
			provenAt: this.now(),
		};
	}

	forget(): void {
		this.entry = null;
	}
}

/** The listener did not prove it holds the token; nothing was sent to it. */
export class UnverifiedPeerError extends Error {
	readonly origin: string;

	constructor(origin: string) {
		super(
			`The listener at ${origin} did not prove it is Shadow; the API token and the request were not sent. Restart Shadow from Ryu, or free the port if another process holds it.`
		);
		this.name = "UnverifiedPeerError";
		this.origin = origin;
	}
}

/** Whether the peer at `origin` holds `token`: a fresh cached proof or a new one. */
export async function peerHoldsToken(
	origin: string,
	token: string,
	cache: PeerProofCache,
	fetchImpl: typeof fetch = fetch
): Promise<boolean> {
	if (cache.isFresh(origin, token)) {
		return true;
	}
	if ((await probePeer(origin, token, fetchImpl)) === "proven") {
		cache.remember(origin, token);
		return true;
	}
	cache.forget();
	return false;
}

/**
 * `fetch(url, init)` with `Authorization: Bearer <token>`, but only after the
 * listener at the URL's own origin proved it holds `token`. An unverified
 * listener receives neither the token nor the request (its body may be as
 * private as the token): this throws {@link UnverifiedPeerError} instead.
 */
export async function fetchWithVerifiedBearer(
	url: string,
	init: RequestInit,
	token: string,
	cache: PeerProofCache,
	fetchImpl: typeof fetch = fetch
): Promise<Response> {
	const { origin } = new URL(url);
	if (!(await peerHoldsToken(origin, token, cache, fetchImpl))) {
		throw new UnverifiedPeerError(origin);
	}
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return await fetchImpl(url, { ...init, headers, redirect: "error" });
}
