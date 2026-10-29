import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Public share links leave the device: prove the real client only talks to the
// configured control plane, with the active bearer, and never without one.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// The client's 15s `AbortSignal.timeout` must stay a native signal for native fetch.
globalThis.AbortSignal = NativeAbortSignal;
const previousBackend = process.env.VITE_APP_BACKEND_URL;
interface LedgerEntry {
	bearer: string | null;
	body: unknown;
	method: string;
	path: string;
}
const ledger: LedgerEntry[] = [];
const egress: string[] = [];
let reply: { body: unknown; status: number } = { body: {}, status: 200 };
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const text = await request.text();
		ledger.push({
			bearer: request.headers.get("authorization"),
			body: text ? JSON.parse(text) : null,
			method: request.method,
			path: url.pathname + url.search,
		});
		return NativeResponse.json(reply.body, { status: reply.status });
	},
});
process.env.VITE_APP_BACKEND_URL = server.url.origin;
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const address =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(address).origin !== server.url.origin) {
			egress.push(address);
			throw new Error("Unowned sharing HTTP origin");
		}
		return await nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;
const { TOKEN_KEY, BACKEND_URL } = await import("@/lib/auth-client.ts");
const {
	getPublicShare,
	getPublicSnapshotMessages,
	publishPublicShare,
	revokePublicShare,
} = await import("./conversation-sharing.ts");
const previousToken = localStorage.getItem(TOKEN_KEY);
const share = { created_at: 1, updated_at: 2, url: "https://ryu.example/s/x" };
const snapshot = [
	{ content: "hi", created_at: 10, id: "m1", role: "user" as const },
];

beforeEach(() => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: The client must resolve the configured control plane.
	expect(BACKEND_URL).toBe(server.url.origin);
	ledger.length = 0;
	egress.length = 0;
	reply = { body: { share }, status: 200 };
	localStorage.setItem(TOKEN_KEY, "session-A");
});
afterEach(() => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: Unowned network access invalidates every case.
	expect(egress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	if (previousBackend === undefined) {
		delete process.env.VITE_APP_BACKEND_URL;
	} else {
		process.env.VITE_APP_BACKEND_URL = previousBackend;
	}
	if (previousToken === null) {
		localStorage.removeItem(TOKEN_KEY);
	} else {
		localStorage.setItem(TOKEN_KEY, previousToken);
	}
});

test("signed-out publish, read and revoke refuse before any request is made", async () => {
	localStorage.removeItem(TOKEN_KEY);
	const message = "Sign in to publish a public link.";
	await expect(publishPublicShare("c1", "T", snapshot)).rejects.toThrow(
		message
	);
	await expect(getPublicShare("c1")).rejects.toThrow(message);
	await expect(revokePublicShare("c1", "user-1")).rejects.toThrow(message);
	expect(ledger).toEqual([]);
});

test("publish sends the bearer, title and snapshot to the encoded control-plane path", async () => {
	expect(await publishPublicShare("chat/1 ?", "Title", snapshot)).toEqual(
		share
	);
	expect(ledger).toEqual([
		{
			bearer: "Bearer session-A",
			body: { messages: snapshot, title: "Title" },
			method: "PUT",
			path: "/api/conversation-shares/conversation/chat%2F1%20%3F",
		},
	]);
});

test("a null share from publish is an error, while a null share from read means not published", async () => {
	reply = { body: { share: null }, status: 200 };
	await expect(publishPublicShare("c1", "T", snapshot)).rejects.toThrow(
		"The share link was not returned."
	);
	expect(await getPublicShare("c1")).toBeNull();
	expect(ledger.map((entry) => `${entry.method} ${entry.bearer}`)).toEqual([
		"PUT Bearer session-A",
		"GET Bearer session-A",
	]);
});

test("revoke names the owner only when one is given", async () => {
	reply = { body: { ok: true }, status: 200 };
	await revokePublicShare("c1", "user 1&x");
	await revokePublicShare("c1");
	expect(ledger).toEqual([
		{
			bearer: "Bearer session-A",
			body: null,
			method: "DELETE",
			path: "/api/conversation-shares/conversation/c1?owner_user_id=user+1%26x",
		},
		{
			bearer: "Bearer session-A",
			body: null,
			method: "DELETE",
			path: "/api/conversation-shares/conversation/c1",
		},
	]);
});

test("a refused request surfaces the server message, or a status fallback", async () => {
	reply = { body: { message: "Not your conversation" }, status: 403 };
	await expect(getPublicShare("c1")).rejects.toThrow("Not your conversation");
	reply = { body: { error: "nope" }, status: 500 };
	await expect(revokePublicShare("c1")).rejects.toThrow(
		"Sharing request failed (500)"
	);
	reply = { body: { message: 7 }, status: 409 };
	await expect(publishPublicShare("c1", "T", snapshot)).rejects.toThrow(
		"Sharing request failed (409)"
	);
});

test("the public snapshot keeps only well-formed user and assistant turns, capped at the last 500", async () => {
	// The snapshot is a Core read; no cloud session (and so no JWT exchange) is involved.
	localStorage.removeItem(TOKEN_KEY);
	const core = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			ledger.push({
				bearer: request.headers.get("authorization"),
				body: null,
				method: request.method,
				path: new URL(request.url).pathname,
			});
			const filler = Array.from({ length: 510 }, (_, index) => ({
				content: `turn ${index}`,
				created_at: index,
				id: `f${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
			}));
			return NativeResponse.json({
				messages: [
					{ content: "secret", created_at: 1, id: "s", role: "system" },
					{ content: "tool out", created_at: 1, id: "t", role: "tool" },
					...filler,
					{ content: 4, created_at: 1, id: "bad-content", role: "user" },
					{ content: "x", created_at: "1", id: "bad-time", role: "user" },
					{ content: "x", created_at: 1, id: 9, role: "assistant" },
					{ content: "x", created_at: 1, role: "assistant" },
					{ content: "last", created_at: 999, id: "z", role: "assistant" },
					{ content: "sys", created_at: 1000, id: "s2", role: "system" },
				],
			});
		},
	});
	const coreUrl = core.url.origin;
	const guardedFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const address = input instanceof Request ? input.url : String(input);
			if (new URL(address).origin !== coreUrl) {
				egress.push(address);
				throw new Error("Snapshot must only read Core");
			}
			return await nativeFetch(input, init);
		},
		{ preconnect: nativeFetch.preconnect }
	);
	try {
		const result = await getPublicSnapshotMessages(
			{ url: coreUrl, token: "node" },
			"c/1"
		);
		expect(ledger).toEqual([
			{
				bearer: "Bearer node",
				body: null,
				method: "GET",
				path: "/api/conversations/c%2F1",
			},
		]);
		expect(result).toHaveLength(500);
		expect(result.at(-1)).toEqual({
			content: "last",
			created_at: 999,
			id: "z",
			role: "assistant",
		});
		expect(result[0]?.id).toBe("f11");
		expect(
			result.every(
				(message) => message.role === "user" || message.role === "assistant"
			)
		).toBe(true);
		expect(result.some((message) => message.id.startsWith("bad"))).toBe(false);
		expect(Object.keys(result[0] ?? {}).sort()).toEqual([
			"content",
			"created_at",
			"id",
			"role",
		]);
	} finally {
		globalThis.fetch = guardedFetch;
		core.stop(true);
	}
});
