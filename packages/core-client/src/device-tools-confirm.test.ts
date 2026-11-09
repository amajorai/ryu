import { describe, expect, test } from "bun:test";
import {
	deviceCanonicalString,
	deviceConfirmMessage,
} from "@ryuhq/protocol/device-tools";
import type { ApiTarget } from "./client.ts";
import {
	confirmOnDevice,
	type DeviceIdentity,
	type DeviceSigner,
	pairDevice,
	postHomeAccessories,
} from "./device-tools.ts";

const ECDSA = { hash: "SHA-256", name: "ECDSA" } as const;

async function webCryptoSigner(): Promise<{
	publicKey: CryptoKey;
	signer: DeviceSigner;
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
		publicKey: pair.publicKey,
		signer: {
			publicKeySpki: () => Promise.resolve(btoa(String.fromCharCode(...spki))),
			sign: async (data) =>
				new Uint8Array(
					await crypto.subtle.sign(ECDSA, pair.privateKey, new Uint8Array(data))
				),
		},
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

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
}

async function identityWith(signer: DeviceSigner): Promise<DeviceIdentity> {
	return {
		deviceId: "6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172",
		principalId: "user:u1",
		signer,
	};
}

describe("on-device confirmation and the Home cache", () => {
	test("an approval carries a user-presence signature over the request, hash and option", async () => {
		const device = await webCryptoSigner();
		const presence = await webCryptoSigner();
		const identity = await identityWith(device.signer);
		const captured: Captured[] = [];
		const target = capturingTarget(
			{ decision: "allow_once", resolved: true },
			captured
		);
		const answer = await confirmOnDevice(
			target,
			identity,
			{
				confirmSigner: presence.signer,
				inputSha256: "hash-1",
				optionId: "allow_once",
				requestId: "perm-dev-1",
			},
			() => 1_800_000_000_000
		);
		expect(answer.decision).toBe("allow_once");
		const sent = captured[0];
		expect(sent?.url).toBe("http://core.test/api/device-tools/confirm");
		const body = JSON.parse(sent?.body ?? "{}");
		expect(body).toMatchObject({
			confirmed_at_ms: 1_800_000_000_000,
			device_id: identity.deviceId,
			input_sha256: "hash-1",
			option_id: "allow_once",
			request_id: "perm-dev-1",
		});
		const message: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
			deviceConfirmMessage({
				confirmedAtMs: 1_800_000_000_000,
				inputSha256: "hash-1",
				optionId: "allow_once",
				requestId: "perm-dev-1",
			})
		);
		const signature = fromBase64(body.confirm_signature);
		expect(
			await crypto.subtle.verify(ECDSA, presence.publicKey, signature, message)
		).toBe(true);
		expect(
			await crypto.subtle.verify(ECDSA, device.publicKey, signature, message),
			"the device key is not the presence key"
		).toBe(false);
		// The request itself is signed by the device key.
		const canonical = await deviceCanonicalString({
			body: new TextEncoder().encode(sent?.body ?? ""),
			deviceId: identity.deviceId,
			method: "POST",
			principalId: "user:u1",
			route: "/api/device-tools/confirm",
			timestampMs: Number(sent?.headers["X-Ryu-Device-Ts"]),
		});
		expect(
			await crypto.subtle.verify(
				ECDSA,
				device.publicKey,
				fromBase64(sent?.headers["X-Ryu-Device-Sig"] ?? ""),
				new TextEncoder().encode(canonical)
			)
		).toBe(true);
	});

	test("a deny needs no biometrics", async () => {
		const device = await webCryptoSigner();
		const captured: Captured[] = [];
		let presenceUsed = false;
		await confirmOnDevice(
			capturingTarget({ decision: "deny", resolved: true }, captured),
			await identityWith(device.signer),
			{
				confirmSigner: {
					sign: () => {
						presenceUsed = true;
						return Promise.resolve(new Uint8Array());
					},
				},
				inputSha256: "hash-1",
				optionId: "deny",
				requestId: "perm-dev-2",
			}
		);
		expect(presenceUsed).toBe(false);
		expect(JSON.parse(captured[0]?.body ?? "{}").confirm_signature).toBe(
			undefined
		);
	});

	test("pairing sends the confirmation key and the Home cache posts service types", async () => {
		const device = await webCryptoSigner();
		const identity = await identityWith(device.signer);
		const captured: Captured[] = [];
		const paired = await pairDevice(
			capturingTarget(
				{
					confirmations: true,
					device_id: identity.deviceId,
					principal_id: "user:u1",
					state: "active",
				},
				captured
			),
			identity,
			{
				app: "ryu-bot",
				confirmPublicKeySpki: "Y29uZmlybQ==",
				label: "Phone",
				platform: "ios",
				publicKeySpki: "c2lnbg==",
			}
		);
		expect(paired.confirmations).toBe(true);
		expect(JSON.parse(captured[0]?.body ?? "{}").confirm_public_key_spki).toBe(
			"Y29uZmlybQ=="
		);
		const stored = await postHomeAccessories(
			capturingTarget({ accessories: 1, ok: true }, captured),
			identity,
			[
				{
					accessory_id: "lock",
					name: "Front door",
					services: ["HMServiceTypeLockMechanism"],
				},
			]
		);
		expect(stored.accessories).toBe(1);
		expect(captured[1]?.url).toBe(
			"http://core.test/api/device-tools/home-accessories"
		);
		expect(JSON.parse(captured[1]?.body ?? "{}")).toEqual({
			accessories: [
				{
					accessory_id: "lock",
					name: "Front door",
					services: ["HMServiceTypeLockMechanism"],
				},
			],
			device_id: identity.deviceId,
		});
	});
});
