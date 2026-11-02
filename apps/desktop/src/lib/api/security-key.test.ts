import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface InvokeCall {
	args: unknown;
	command: string;
}
const invokeCalls: InvokeCall[] = [];
let invokeResult: (command: string) => Promise<unknown> = () =>
	Promise.resolve(null);
const tauriReady = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...tauriReady,
	invokeWhenReady: (command: string, args?: unknown) => {
		invokeCalls.push({ args, command });
		return invokeResult(command);
	},
}));

const {
	answerSecurityKeyRequest,
	isPinRequired,
	isRetryableSecurityKeyError,
	listSecurityKeyRequests,
	performSecurityKeyRequest,
	securityKeyAvailability,
	securityKeyErrorCode,
	securityKeyErrorDetail,
	withLocalDeadline,
} = await import("./security-key.ts");

const target = { token: "node-token", url: "http://node.test:7980" };
const realFetch = globalThis.fetch;
let fetched: Array<{ body: unknown; method: string; url: string }> = [];
let respond: (url: string) => Response = () => Response.json({ requests: [] });

function pending(id: string, createdAt: number) {
	return {
		agent_id: null,
		client_data_json: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
		created_at_ms: createdAt,
		expires_at_ms: createdAt + 60_000,
		id,
		kind: "get",
		options: { challenge: "Y2hhbGxlbmdl" },
		origin: "https://example.com",
		page_url: "https://example.com/login",
		rp_id: "example.com",
	};
}

beforeEach(() => {
	fetched = [];
	invokeCalls.length = 0;
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			fetched.push({
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				method: init?.method ?? "GET",
				url,
			});
			return Promise.resolve(respond(url));
		},
		{ preconnect: realFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("listSecurityKeyRequests", () => {
	test("returns valid requests oldest first and skips malformed rows", async () => {
		respond = () =>
			Response.json({
				requests: [
					pending("late", 200),
					{ id: "broken" },
					pending("early", 100),
				],
			});
		const requests = await listSecurityKeyRequests(target);
		expect(requests.map((entry) => entry.id)).toEqual(["early", "late"]);
		expect(fetched[0]?.url).toBe(
			"http://node.test:7980/api/security-key/requests"
		);
	});

	test("rejects when Core refuses the read", async () => {
		respond = () => Response.json({ error: "nope" }, { status: 403 });
		await expect(listSecurityKeyRequests(target)).rejects.toBeDefined();
	});
});

test("answerSecurityKeyRequest posts the decision to the request's route", async () => {
	respond = () => Response.json({ ok: true });
	await answerSecurityKeyRequest(target, "req/1", {
		decision: "deny",
		reason: "denied_by_user",
	});
	expect(fetched).toEqual([
		{
			body: { decision: "deny", reason: "denied_by_user" },
			method: "POST",
			url: "http://node.test:7980/api/security-key/requests/req%2F1/response",
		},
	]);
});

describe("native commands", () => {
	test("perform passes the request and parses the credential", async () => {
		invokeResult = () =>
			Promise.resolve({
				id: "Y3JlZA",
				response: {
					authenticator_data: "YXV0aA",
					kind: "assertion",
					signature: "c2ln",
				},
			});
		const request = { ...pending("one", 1), kind: "get" as const };
		const credential = await performSecurityKeyRequest(request);
		expect(credential.id).toBe("Y3JlZA");
		expect(invokeCalls).toEqual([
			{ args: { request }, command: "security_key_perform" },
		]);
	});

	test("a PIN goes through the with-pin command", async () => {
		invokeResult = () =>
			Promise.resolve({
				id: "Y3JlZA",
				response: {
					attestation_object: "b2Jq",
					kind: "attestation",
					transports: ["usb"],
				},
			});
		const request = { ...pending("two", 1), kind: "create" as const };
		await performSecurityKeyRequest(request, "1234");
		expect(invokeCalls).toEqual([
			{
				args: { pin: "1234", request },
				command: "security_key_perform_with_pin",
			},
		]);
	});

	test("native errors propagate unchanged", async () => {
		invokeResult = () => Promise.reject("pin_required");
		await expect(
			performSecurityKeyRequest({ ...pending("three", 1), kind: "get" })
		).rejects.toBe("pin_required");
	});

	test("availability reports a missing bridge as unavailable", async () => {
		invokeResult = () => Promise.reject(new Error("no desktop backend"));
		expect(await securityKeyAvailability()).toEqual({
			available: false,
			platform: "unknown",
			reason: "no desktop backend",
		});
		invokeResult = () =>
			Promise.resolve({ available: true, platform: "linux" });
		expect(await securityKeyAvailability()).toEqual({
			available: true,
			platform: "linux",
		});
	});
});

test("error helpers read the native error code and detail", () => {
	expect(isPinRequired("pin_required")).toBe(true);
	expect(isPinRequired("pin_required: wrong PIN (2 attempts left)")).toBe(true);
	expect(isPinRequired("pin_blocked: too many tries")).toBe(false);
	expect(securityKeyErrorCode(new Error("timeout: no key"))).toBe("timeout");
	expect(securityKeyErrorCode("Something odd")).toBe("device");
	expect(securityKeyErrorDetail("pin_required: wrong PIN")).toBe("wrong PIN");
	expect(securityKeyErrorDetail("pin_required")).toBeNull();
	expect(isRetryableSecurityKeyError("timeout: slow")).toBe(true);
	expect(isRetryableSecurityKeyError("no_credentials: none")).toBe(false);
});

describe("withLocalDeadline", () => {
	const parse = (raw: unknown) =>
		raw as Parameters<typeof withLocalDeadline>[0];

	test("keeps the node's window but moves it onto this clock", () => {
		// The node's clock is a day behind this one.
		const local = withLocalDeadline(parse(pending("a", 1000)), 86_400_000);
		expect(local.expires_at_ms).toBe(86_400_000 + 60_000);
		expect(local.created_at_ms).toBe(1000);
		expect(local.id).toBe("a");
	});

	test("never grants more than the relay maximum or less than nothing", () => {
		const long = { ...pending("long", 0), expires_at_ms: 10_000_000 };
		expect(withLocalDeadline(parse(long), 5).expires_at_ms).toBe(120_005);
		const backwards = { ...pending("back", 500), expires_at_ms: 100 };
		expect(withLocalDeadline(parse(backwards), 5).expires_at_ms).toBe(5);
	});
});
