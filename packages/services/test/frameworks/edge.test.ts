// Executable snippet and edge-safety checks for
// apps/fumadocs/content/docs/standalone/sdk/frameworks/edge.mdx.
//
// The `// docs:start edge-worker` … `// docs:end edge-worker` region is the
// page's code block; apps/fumadocs/src/lib/standalone-sdk-docs.test.ts fails
// when they differ. `// docs:show <text>` lines render as `<text>` (the
// published import specifiers do not resolve inside this package, so the real
// imports at the top of this file load the same entry points by relative
// path), and leading tabs render as two spaces.
//
// The page lists which entry points are edge-safe. The source scans below are
// what that list rests on: no entry point's import graph reaches a `node:`
// module, and the webhooks entry point reaches no client code at all.

// biome-ignore-all lint/suspicious/noExportsInTest: the default export is the documented Worker module.

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Ryu } from "../../src/index.ts";
import {
	type NotifyWebhookDelivery,
	webhookHandler,
} from "../../src/webhooks/index.ts";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const CLIENT_ENTRY = resolve(PACKAGE_ROOT, "../client/src/index.ts");
const DESTINATION_SECRET = "test-destination-secret";
const ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "test-notify-tenant-key",
	NOTIFY_DESTINATION_SECRET: DESTINATION_SECRET,
};
const PUBLISHED = JSON.parse(
	readFileSync(
		resolve(import.meta.dir, "../fixtures/notify/publish-created.json"),
		"utf8"
	)
) as { body: unknown; headers: Record<string, string>; status: number };

const requests: Request[] = [];
const deliveries: NotifyWebhookDelivery[] = [];
let nextResponse: () => Response;
const realFetch = globalThis.fetch;

/** The app's own code in the docs; here it records each verified delivery. */
function recordDelivery(delivery: NotifyWebhookDelivery): Promise<void> {
	deliveries.push(delivery);
	return Promise.resolve();
}

beforeAll(() => {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return Promise.resolve(nextResponse());
		},
		{ preconnect: realFetch.preconnect }
	);
});

afterAll(() => {
	globalThis.fetch = realFetch;
});

beforeEach(() => {
	requests.length = 0;
	deliveries.length = 0;
	nextResponse = () =>
		new Response(JSON.stringify(PUBLISHED.body), {
			status: PUBLISHED.status,
			headers: PUBLISHED.headers,
		});
});

// docs:start edge-worker
// docs:show import { Ryu } from "@ryuhq/services";
// docs:show import { webhookHandler } from "@ryuhq/services/webhooks";
// docs:show
interface Env {
	NOTIFY_DESTINATION_SECRET: string;
	RYU_NOTIFY_API_KEY: string;
	RYU_NOTIFY_URL?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/webhooks/notify") {
			// Verifies the raw body with WebCrypto; answers 401 to a bad signature.
			const handle = webhookHandler({
				service: "notify",
				kind: "destination",
				secret: env.NOTIFY_DESTINATION_SECRET,
				// Your own code. Retries reuse a deliveryId: dedupe on it.
				onEvent: (delivery) => recordDelivery(delivery),
			});
			return handle(request);
		}
		if (pathname === "/deploys" && request.method === "POST") {
			// Bindings are not in process.env unless you copy them there: pass them as env.
			const ryu = new Ryu({ env: { ...env }, result: "object" });
			const { data, error } = await ryu.notify.publish({
				title: "Deploy finished",
				level: "success",
			});
			return error
				? Response.json({ code: error.code }, { status: 502 })
				: Response.json({ id: data.id }, { status: 201 });
		}
		return new Response("Not found", { status: 404 });
	},
};
// docs:end edge-worker

/** Calls the documented Worker module (this file's default export) with test bindings. */
async function callWorker(request: Request, env: Env = ENV): Promise<Response> {
	const module = (await import(import.meta.path)) as {
		default: { fetch(request: Request, env: Env): Promise<Response> };
	};
	return module.default.fetch(request, env);
}

/** Standard Webhooks headers, as current Notify servers send them on a signed delivery. */
async function standardHeaders(
	id: string,
	body: string,
	timestampSeconds = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(DESTINATION_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const mac = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`${id}.${timestampSeconds}.${body}`)
		)
	);
	return {
		"webhook-id": id,
		"webhook-timestamp": String(timestampSeconds),
		"webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
	};
}

async function sign(body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(DESTINATION_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const mac = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
	);
	return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// The keyword must not sit inside a string or path (`"import"`, `/import"`).
const SPECIFIER = /(?<![\w"'/.$])(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** Every module reachable from `entry`, following relative imports and `@ryuhq/client`. */
function importGraph(entry: string): {
	bare: Set<string>;
	files: Set<string>;
} {
	const files = new Set<string>();
	const bare = new Set<string>();
	const visit = (file: string) => {
		if (files.has(file)) {
			return;
		}
		files.add(file);
		const source = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[1] ?? "";
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), specifier);
				visit(existsSync(target) ? target : `${target}.ts`);
			} else if (specifier === "@ryuhq/client") {
				visit(CLIENT_ENTRY);
			} else {
				bare.add(specifier);
			}
		}
	};
	visit(entry);
	return { bare, files };
}

describe("edge Worker snippet", () => {
	test("publishes to Notify with the bindings passed as env", async () => {
		const response = await callWorker(
			new Request("https://worker.example.com/deploys", { method: "POST" })
		);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			id: "evt_220eb04632bc4239be622f93ea63a8ec",
		});
		expect(requests[0]?.url).toBe("https://notify.example.com/v1/events");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer test-notify-tenant-key"
		);
	});

	test("answers 502 with the code when Notify refuses", async () => {
		nextResponse = () =>
			Response.json(
				{
					ok: false,
					type: "notify.error",
					code: "insufficient_credits",
					message: "No credits.",
					status: 402,
					requestId: "req_edge_402",
					error: {
						code: "insufficient_credits",
						message: "No credits.",
						requestId: "req_edge_402",
						status: 402,
					},
				},
				{ status: 402 }
			);
		const response = await callWorker(
			new Request("https://worker.example.com/deploys", { method: "POST" })
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ code: "insufficient_credits" });
		expect(requests).toHaveLength(1);
	});

	test("verifies a signed Notify destination delivery and hands it over", async () => {
		const body = JSON.stringify({
			deliveryId: "dlv_1",
			event: { id: "evt_1", title: "Deploy finished" },
			type: "notification",
		});
		const response = await callWorker(
			new Request("https://worker.example.com/webhooks/notify", {
				method: "POST",
				body,
				headers: {
					...(await standardHeaders("dlv_1", body)),
					"x-ryu-notify-signature": await sign(body),
					"x-ryu-notify-event": "evt_1",
					"x-ryu-notify-delivery": "dlv_1",
				},
			})
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(
			deliveries.map((delivery) => [
				delivery.deliveryId,
				delivery.replayProtected,
			])
		).toEqual([["dlv_1", true]]);
	});

	test("refuses a body-only signature by default", async () => {
		const body = JSON.stringify({
			deliveryId: "dlv_2",
			event: { id: "evt_2", title: "Deploy finished" },
			type: "notification",
		});
		const response = await callWorker(
			new Request("https://worker.example.com/webhooks/notify", {
				method: "POST",
				body,
				headers: { "x-ryu-notify-signature": await sign(body) },
			})
		);
		expect(response.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	test("refuses a replay whose signed timestamp is outside the tolerance", async () => {
		const body = JSON.stringify({
			deliveryId: "dlv_3",
			event: { id: "evt_3", title: "Deploy finished" },
			type: "notification",
		});
		const stale = Math.floor(Date.now() / 1000) - 3600;
		const response = await callWorker(
			new Request("https://worker.example.com/webhooks/notify", {
				method: "POST",
				body,
				headers: await standardHeaders("dlv_3", body, stale),
			})
		);
		expect(response.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	test("answers 401 to a forged delivery without calling onEvent", async () => {
		const response = await callWorker(
			new Request("https://worker.example.com/webhooks/notify", {
				method: "POST",
				body: "{}",
				headers: { "x-ryu-notify-signature": await sign("other") },
			})
		);
		expect(response.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	test("answers 401 webhook_invalid_secret when the secret binding is missing", async () => {
		const body = JSON.stringify({
			deliveryId: "dlv_5",
			event: { id: "evt_5", title: "Deploy finished" },
			type: "notification",
		});
		const { NOTIFY_DESTINATION_SECRET: _unset, ...withoutSecret } = ENV;
		const response = await callWorker(
			new Request("https://worker.example.com/webhooks/notify", {
				method: "POST",
				body,
				headers: await standardHeaders("dlv_5", body),
			}),
			// SAFETY: a Worker whose secret binding is missing at run time.
			withoutSecret as Env
		);
		expect(response.status).toBe(401);
		expect(await response.text()).toContain("webhook_invalid_secret");
		expect(deliveries).toHaveLength(0);
	});

	test("answers 404 elsewhere", async () => {
		const response = await callWorker(
			new Request("https://worker.example.com/")
		);
		expect(response.status).toBe(404);
	});

	test("the shown imports are the entry points the Worker uses", () => {
		expect(typeof webhookHandler).toBe("function");
		expect(new Ryu({ env: false }).resultMode).toBe("throw");
	});
});

describe("edge-safe entry points", () => {
	const entries = {
		"@ryuhq/services": resolve(PACKAGE_ROOT, "src/index.ts"),
		"@ryuhq/services/webhooks": resolve(PACKAGE_ROOT, "src/webhooks/index.ts"),
		"@ryuhq/services/errors": resolve(PACKAGE_ROOT, "src/errors.ts"),
	};

	test.each(
		Object.entries(entries)
	)("%s reaches no node: module", (_name, entry) => {
		const { bare } = importGraph(entry);
		expect([...bare].filter((s) => s.startsWith("node:"))).toEqual([]);
	});

	test("the webhooks entry point reaches no client code and no package", () => {
		const { bare, files } = importGraph(entries["@ryuhq/services/webhooks"]);
		expect([...bare]).toEqual([]);
		expect([...files].some((file) => file.includes("/client/src/"))).toBe(
			false
		);
		expect(
			[...files].some((file) => file.includes("/src/transport/fetch-shim"))
		).toBe(false);
	});

	test("the root entry point imports only @ryuhq/client (and the protocol SSE reader it uses) and zod", () => {
		const { bare } = importGraph(entries["@ryuhq/services"]);
		expect([...bare].sort()).toEqual(["@ryuhq/protocol/sse", "zod"]);
	});

	test("@react-email/render is an optional dynamic import, not a static one", () => {
		const helpers = readFileSync(
			resolve(PACKAGE_ROOT, "src/mail/helpers.ts"),
			"utf8"
		);
		expect(helpers).toContain(
			'REACT_EMAIL_RENDER_MODULE = "@react-email/render"'
		);
		expect(helpers).not.toMatch(/from\s+["']@react-email\/render["']/);
	});
});
