import { afterEach, expect, test } from "bun:test";
import {
	fetchWithVerifiedBearer,
	isValidChallenge,
	newChallenge,
	PeerProofCache,
	peerProof,
	probePeer,
	UnverifiedPeerError,
	verifyPeerProof,
} from "./shadow-peer-proof.ts";

const CHALLENGE = "0123456789abcdef0123456789abcdef";

type FakeHealth =
	| { kind: "proves"; token: string }
	| { kind: "no-proof" }
	| { kind: "huge" }
	| { kind: "redirect" };

interface SeenRequest {
	authorization: string | null;
	body: string;
	path: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

/** A loopback listener that answers `/health` per `health` and records requests. */
function fakeShadow(health: FakeHealth): {
	origin: string;
	seen: SeenRequest[];
} {
	const seen: SeenRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				authorization: request.headers.get("authorization"),
				body: await request.text(),
				path: `${url.pathname}${url.search}`,
			});
			if (url.pathname !== "/health") {
				return Response.json({ ok: true });
			}
			const challenge = url.searchParams.get("challenge") ?? "";
			switch (health.kind) {
				case "proves":
					return Response.json({
						status: "healthy",
						proof: peerProof(health.token, challenge),
					});
				case "no-proof":
					return Response.json({ status: "healthy" });
				case "huge":
					return Response.json({ status: "x".repeat(8192), proof: "0" });
				default:
					return Response.redirect("http://127.0.0.1:1/health", 302);
			}
		},
	});
	servers.push(server);
	return { origin: `http://127.0.0.1:${server.port}`, seen };
}

test("the proof matches the Rust peer_proof reference vector", () => {
	// The same vector pins `proof("token", CHALLENGE)` in
	// crates/core/sidecar-runtime/src/peer_proof.rs, so both sides agree.
	expect(peerProof("token", CHALLENGE)).toBe(
		"c70e8b6b85ca22652a1636872ebe8403aef0a66d5ba962ab752afd1b2082e38f"
	);
});

test("verification accepts only the matching proof and fails closed", () => {
	const good = peerProof("token", CHALLENGE) ?? "";
	expect(verifyPeerProof("token", CHALLENGE, good)).toBe(true);
	expect(verifyPeerProof("token", CHALLENGE, good.toUpperCase())).toBe(true);
	expect(verifyPeerProof("other", CHALLENGE, good)).toBe(false);
	expect(verifyPeerProof("token", CHALLENGE, good.slice(0, 63))).toBe(false);
	expect(verifyPeerProof("token", CHALLENGE, "")).toBe(false);
	expect(peerProof("", CHALLENGE)).toBeNull();
	expect(verifyPeerProof("", CHALLENGE, "")).toBe(false);
	expect(peerProof("token", "short")).toBeNull();
	expect(peerProof("token", "a".repeat(129))).toBeNull();
	expect(peerProof("token", "0123456789abcdef0123456789abcde/")).toBeNull();
});

test("minted challenges are valid and unique", () => {
	const first = newChallenge();
	expect(isValidChallenge(first)).toBe(true);
	expect(first).not.toBe(newChallenge());
});

test("a proven Shadow receives the bearer and the request", async () => {
	const { origin, seen } = fakeShadow({ kind: "proves", token: "the-token" });
	const cache = new PeerProofCache(60_000);
	const response = await fetchWithVerifiedBearer(
		`${origin}/capture/control`,
		{ method: "POST", body: JSON.stringify({ paused: true }) },
		"the-token",
		cache
	);
	expect(response.ok).toBe(true);
	expect(seen).toHaveLength(2);
	expect(seen[0]?.path.startsWith("/health?challenge=")).toBe(true);
	expect(seen[0]?.authorization).toBeNull();
	expect(seen[1]?.authorization).toBe("Bearer the-token");
	expect(seen[1]?.body).toBe('{"paused":true}');

	// A fresh proof is reused, so a burst does not re-challenge Shadow.
	await fetchWithVerifiedBearer(`${origin}/proactive`, {}, "the-token", cache);
	expect(
		seen.filter((request) => request.path.startsWith("/health"))
	).toHaveLength(1);
});

test("an unproven listener receives neither the token nor the request", async () => {
	for (const health of [
		{ kind: "no-proof" },
		{ kind: "proves", token: "another-token" },
		{ kind: "huge" },
	] satisfies FakeHealth[]) {
		const { origin, seen } = fakeShadow(health);
		const attempt = fetchWithVerifiedBearer(
			`${origin}/capture/control`,
			{ method: "POST", body: "private" },
			"the-token",
			new PeerProofCache(60_000)
		);
		await expect(attempt).rejects.toBeInstanceOf(UnverifiedPeerError);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.path.startsWith("/health?challenge=")).toBe(true);
		expect(seen[0]?.authorization).toBeNull();
		expect(seen[0]?.body).toBe("");
	}
});

test("the probe classifies listeners and never follows redirects", async () => {
	const proven = fakeShadow({ kind: "proves", token: "the-token" });
	expect(await probePeer(proven.origin, "the-token")).toBe("proven");
	expect(await probePeer(`${proven.origin}/`, "the-token")).toBe("proven");
	expect(await probePeer(proven.origin, "rotated")).toBe("wrong-proof");
	const silent = fakeShadow({ kind: "no-proof" });
	expect(await probePeer(silent.origin, "the-token")).toBe("no-proof");
	const redirecting = fakeShadow({ kind: "redirect" });
	expect(await probePeer(redirecting.origin, "the-token")).toBe("unreachable");
	expect(await probePeer("http://127.0.0.1:1", "the-token")).toBe(
		"unreachable"
	);
});

test("the proof cache is keyed by origin and token, expires, and forgets", () => {
	let now = 1000;
	const cache = new PeerProofCache(2000, () => now);
	expect(cache.isFresh("http://127.0.0.1:1", "token")).toBe(false);
	cache.remember("http://127.0.0.1:1", "token");
	expect(cache.isFresh("http://127.0.0.1:1", "token")).toBe(true);
	expect(cache.isFresh("http://127.0.0.1:2", "token")).toBe(false);
	expect(cache.isFresh("http://127.0.0.1:1", "rotated")).toBe(false);
	now += 2000;
	expect(cache.isFresh("http://127.0.0.1:1", "token")).toBe(false);
	cache.remember("http://127.0.0.1:1", "token");
	cache.forget();
	expect(cache.isFresh("http://127.0.0.1:1", "token")).toBe(false);
});
