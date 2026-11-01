import { createHmac } from "node:crypto";

/**
 * Authenticator-code and Core node peers for the account-billing coverage
 * suites, split out of `account-billing.native-http.helpers.ts` (which
 * re-exports them, so suites keep importing from there).
 *
 * test-exempt: test-only fixture; the BillingTab and TwoFactorDialog
 * native-HTTP coverage suites exercise it end to end.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of input.replace(/=+$/u, "").toUpperCase()) {
		const index = BASE32.indexOf(char);
		if (index < 0) {
			throw new Error(`Not a base32 setup key: ${input}`);
		}
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/**
 * An authenticator app's RFC 6238 code for a base32 setup key, computed
 * independently of Better Auth's own OTP helper.
 */
export function authenticatorCode(setupKey: string, at = Date.now()): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
	const digest = createHmac("sha1", base32Decode(setupKey))
		.update(counter)
		.digest();
	const offset = (digest.at(-1) ?? 0) & 0x0f;
	const binary = digest.readUInt32BE(offset) & 0x7f_ff_ff_ff;
	return String(binary % 1_000_000).padStart(6, "0");
}

export interface NodeCall {
	body: unknown;
	method: string;
	node: string | null;
	path: string;
	status: number;
}

export interface NodePeer {
	calls: NodeCall[];
	/** Holds the next matching request until the returned release is called. */
	hold: (node: string, method: string, path: string) => () => void;
	/** Raw preference values per node. */
	preferences: Record<string, Map<string, string>>;
	refuseNext: (
		node: string,
		method: string,
		path: string,
		status: number
	) => void;
	stop: () => void;
	tokenFor: (node: string) => string;
	unknown: string[];
	urlFor: (node: string) => string;
}

/**
 * Core node peers for the preference routes (`GET`/`PUT
 * /api/preferences/:key`, `apps/core/src/routes/preferences.rs`), one per
 * name, each demanding its own node bearer.
 */
export function startNodePeer(names: string[]): NodePeer {
	const calls: NodeCall[] = [];
	const unknown: string[] = [];
	const preferences = Object.fromEntries(
		names.map((name) => [name, new Map<string, string>()])
	);
	const holds = new Map<string, Promise<void>>();
	const refusals = new Map<string, number[]>();
	const tokenFor = (node: string) => `node-${node}-token`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const [, node = "", ...rest] = url.pathname.split("/");
			const path = `/${rest.join("/")}`;
			const raw = request.method === "GET" ? "" : await request.text();
			const call: NodeCall = {
				body: raw ? JSON.parse(raw) : null,
				method: request.method,
				node: names.includes(node) ? node : null,
				path,
				status: 0,
			};
			calls.push(call);
			const reply = (payload: unknown, status = 200) => {
				call.status = status;
				return Response.json(payload, { status });
			};
			if (
				!call.node ||
				request.headers.get("authorization") !== `Bearer ${tokenFor(node)}`
			) {
				unknown.push(`${request.method} ${url.pathname}: wrong node authority`);
				return reply({ error: "Wrong node authority" }, 401);
			}
			const key = `${node} ${request.method} ${path}`;
			const held = holds.get(key);
			if (held) {
				holds.delete(key);
				await held;
			}
			const refusal = refusals.get(key)?.shift();
			if (refusal) {
				return reply({ error: "Node refused the request" }, refusal);
			}
			const match = /^\/api\/preferences\/([^/]+)$/u.exec(path);
			const store = preferences[node];
			if (match && store) {
				const prefKey = decodeURIComponent(match[1] ?? "");
				if (request.method === "GET") {
					const value = store.get(prefKey);
					return value === undefined
						? reply({ error: "Preference not found" }, 404)
						: reply({ key: prefKey, value });
				}
				if (request.method === "PUT") {
					const value = (call.body as { value?: unknown })?.value;
					if (typeof value !== "string") {
						return reply({ error: "value must be a string" }, 400);
					}
					store.set(prefKey, value);
					return reply({ key: prefKey, value });
				}
			}
			unknown.push(`${request.method} ${url.pathname}`);
			return reply({ error: "Undeclared node contract" }, 404);
		},
	});
	const origin = server.url.origin;
	return {
		calls,
		hold: (node, method, path) => {
			let release: () => void = () => undefined;
			holds.set(
				`${node} ${method} ${path}`,
				new Promise<void>((resolve) => {
					release = resolve;
				})
			);
			return () => release();
		},
		preferences,
		refuseNext: (node, method, path, status) => {
			const key = `${node} ${method} ${path}`;
			refusals.set(key, [...(refusals.get(key) ?? []), status]);
		},
		stop: () => server.stop(true),
		tokenFor,
		unknown,
		urlFor: (node) => `${origin}/${node}`,
	};
}
