import { describe, expect, test } from "bun:test";
import { deviceCanonicalString } from "@ryuhq/protocol/device-tools";
import type { ApiTarget } from "./client.ts";
import {
	claimDeviceCall,
	type DeviceIdentity,
	fetchDeviceToolCatalog,
	openDeviceStream,
	postDeviceResult,
	signChatStreamBody,
} from "./device-tools.ts";

async function webCryptoIdentity(): Promise<{
	identity: DeviceIdentity;
	publicKey: CryptoKey;
}> {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"]
	);
	const spki = new Uint8Array(
		await crypto.subtle.exportKey("spki", pair.publicKey)
	);
	return {
		identity: {
			deviceId: "6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172",
			principalId: "user:u1",
			signer: {
				publicKeySpki: () =>
					Promise.resolve(btoa(String.fromCharCode(...spki))),
				sign: async (data) =>
					new Uint8Array(
						await crypto.subtle.sign(
							{ hash: "SHA-256", name: "ECDSA" },
							pair.privateKey,
							new Uint8Array(data)
						)
					),
			},
		},
		publicKey: pair.publicKey,
	};
}

interface Captured {
	body: string;
	headers: Record<string, string>;
	url: string;
}

function capturingTarget(reply: unknown, captured: Captured[]): ApiTarget {
	return {
		fetch: (input, init) => {
			captured.push({
				body: String(init?.body ?? ""),
				headers: init?.headers as Record<string, string>,
				url: String(input),
			});
			return Promise.resolve(Response.json(reply));
		},
		token: "node-token",
		url: "http://core.test/",
	};
}

async function verifies(
	publicKey: CryptoKey,
	captured: Captured,
	route: string,
	principalId: string,
	method = "POST"
): Promise<boolean> {
	const canonical = await deviceCanonicalString({
		body: new TextEncoder().encode(captured.body),
		deviceId: captured.headers["X-Ryu-Client-Id"] ?? "",
		method,
		principalId,
		route,
		timestampMs: Number(captured.headers["X-Ryu-Device-Ts"]),
	});
	const signature = Uint8Array.from(
		atob(captured.headers["X-Ryu-Device-Sig"] ?? ""),
		(c) => c.charCodeAt(0)
	);
	return crypto.subtle.verify(
		{ hash: "SHA-256", name: "ECDSA" },
		publicKey,
		signature,
		new TextEncoder().encode(canonical)
	);
}

describe("device-tools client", () => {
	test("claim signs exactly the bytes it sends", async () => {
		const { identity, publicKey } = await webCryptoIdentity();
		const captured: Captured[] = [];
		const target = capturingTarget(
			{
				claim_id: "c1",
				deadline_ms: 1,
				input: { title: "Dentist" },
				input_sha256: "abc",
				tool: "device.calendar.create",
			},
			captured
		);
		const claim = await claimDeviceCall(target, identity, {
			conversationId: "conv",
			toolCallId: "call",
		});
		expect(claim.input).toEqual({ title: "Dentist" });
		const sent = captured[0];
		expect(sent?.url).toBe("http://core.test/api/device-tools/claim");
		expect(sent?.headers.Authorization).toBe("Bearer node-token");
		expect(JSON.parse(sent?.body ?? "{}")).toEqual({
			conversation_id: "conv",
			device_id: identity.deviceId,
			phase: "execute",
			tool_call_id: "call",
		});
		expect(
			await verifies(
				publicKey,
				sent as Captured,
				"/api/device-tools/claim",
				"user:u1"
			)
		).toBe(true);
		expect(
			await verifies(
				publicKey,
				sent as Captured,
				"/api/device-tools/claim",
				"user:u2"
			)
		).toBe(false);
	});

	test("results echo the claim and its frozen hash with device provenance", async () => {
		const { identity, publicKey } = await webCryptoIdentity();
		const captured: Captured[] = [];
		await postDeviceResult(capturingTarget({ ok: true }, captured), identity, {
			app: "ryu-bot",
			claim: {
				claim_id: "c1",
				deadline_ms: 1,
				input: {},
				input_sha256: "abc",
				tool: "device.timer.set",
			},
			conversationId: "conv",
			platform: "ios",
			result: { data: { started: true }, ok: true },
			toolCallId: "call",
		});
		const body = JSON.parse(captured[0]?.body ?? "{}");
		expect(body.claim_id).toBe("c1");
		expect(body.input_sha256).toBe("abc");
		expect(body.provenance).toEqual({
			app: "ryu-bot",
			device_id: identity.deviceId,
			platform: "ios",
			source: "ryu-device",
		});
		expect(
			await verifies(
				publicKey,
				captured[0] as Captured,
				"/api/chat/client-tool-result",
				"user:u1"
			)
		).toBe(true);
	});

	test("chat stream bodies are signed as sent", async () => {
		const { identity } = await webCryptoIdentity();
		const signed = await signChatStreamBody(identity, { messages: [] });
		expect(signed.body).toBe('{"messages":[]}');
		expect(signed.headers["X-Ryu-Client-Id"]).toBe(identity.deviceId);
		expect(signed.headers["X-Ryu-Device-Sig"]?.length).toBeGreaterThan(0);
	});

	test("a refused claim surfaces Core's code", async () => {
		const { identity } = await webCryptoIdentity();
		const target: ApiTarget = {
			fetch: () =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							code: "already_claimed",
							error: "already started",
						}),
						{ status: 409 }
					)
				),
			token: null,
			url: "http://core.test",
		};
		await expect(
			claimDeviceCall(target, identity, {
				conversationId: "c",
				toolCallId: "t",
			})
		).rejects.toMatchObject({ code: "already_claimed", status: 409 });
	});
});

describe("device stream and caps", () => {
	test("the stream connect is a GET signed over an empty body", async () => {
		const { identity, publicKey } = await webCryptoIdentity();
		const captured: Captured[] = [];
		const target: ApiTarget = {
			fetch: (input, init) => {
				captured.push({
					body: String(init?.body ?? ""),
					headers: init?.headers as Record<string, string>,
					url: String(input),
				});
				expect(init?.method).toBe("GET");
				return Promise.resolve(
					new Response(": connected\n\n", {
						headers: { "content-type": "text/event-stream" },
					})
				);
			},
			token: "node-token",
			url: "http://core.test/",
		};
		const response = await openDeviceStream(target, identity);
		expect(await response.text()).toBe(": connected\n\n");
		const sent = captured[0];
		expect(sent?.url).toBe("http://core.test/api/device-tools/stream");
		expect(sent?.body).toBe("");
		expect(sent?.headers.accept).toBe("text/event-stream");
		expect(
			sent &&
				(await verifies(
					publicKey,
					sent,
					"/api/device-tools/stream",
					"user:u1",
					"GET"
				))
		).toBe(true);
		expect(
			sent &&
				(await verifies(
					publicKey,
					sent,
					"/api/device-tools/stream",
					"user:u1",
					"POST"
				))
		).toBe(false);
	});

	test("a refused stream connect surfaces the device error code", async () => {
		const { identity } = await webCryptoIdentity();
		const target: ApiTarget = {
			fetch: () =>
				Promise.resolve(
					Response.json(
						{ code: "invalid_signature", error: "could not be verified" },
						{ status: 401 }
					)
				),
			token: "node-token",
			url: "http://core.test/",
		};
		await expect(openDeviceStream(target, identity)).rejects.toMatchObject({
			code: "invalid_signature",
			status: 401,
		});
	});

	test("catalog caps are never or per-app caps, nothing else", async () => {
		const reply = (caps: unknown) =>
			fetchDeviceToolCatalog(
				capturingTarget(
					{ caps, catalog: {}, enabled: true, principal_id: "user:u1" },
					[]
				)
			);
		expect((await reply("never")).caps).toBe("never");
		expect((await reply({ calendar: "ask" })).caps).toEqual({
			calendar: "ask",
		});
		await expect(reply({ calendar: "sometimes" })).rejects.toThrow();
		await expect(reply("open")).rejects.toThrow();
	});
});
