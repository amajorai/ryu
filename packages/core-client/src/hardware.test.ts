import { describe, expect, test } from "bun:test";
import {
	HardwareApiError,
	hardwareDeviceSchema,
	hardwareIdentityResetResponseSchema,
	hardwarePairBeginResponseSchema,
	hardwarePairConfirmResponseSchema,
	hardwarePairRevealResponseSchema,
	listDevices,
	listDevicesWithIdentity,
	pairBegin,
	pairCancel,
	pairConfirm,
	pairReveal,
	resetHardwareIdentity,
} from "./hardware.ts";

const legacyDevice = {
	device_id: "rhw_0123456789abcdef",
	type: "watch" as const,
	name: "Watch",
	last_seen: null,
	online: false,
	battery_pct: null,
};

const secureDevice = {
	...legacyDevice,
	protocol_level: 2,
	secure: true,
	key_verification: "sas",
	key_source: "qr",
	key_fingerprint: "a59c-05e1-b559-f5b4",
	needs_repair: false,
	capabilities: [
		{
			name: "device.status",
			description: "Report firmware and link status",
			sensitive: false,
			confirm: "none",
			enabled: true,
		},
	],
};

interface RecordedCall {
	body: unknown;
	method: string;
	url: string;
}

function recordingTarget(status: number, payload: unknown) {
	const calls: RecordedCall[] = [];
	return {
		calls,
		target: {
			url: "https://node.example/",
			token: "node-token",
			fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(url),
					method: init?.method ?? "GET",
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				return Response.json(payload, { status });
			},
		},
	};
}

describe("hardware device schema", () => {
	test("accepts a v1 device without any v1.1 field", () => {
		expect(hardwareDeviceSchema.safeParse(legacyDevice).success).toBe(true);
	});

	test("accepts the v1.1 fields and keeps unknown future fields", () => {
		const future = { ...secureDevice, future_field: { nested: [1] } };
		expect(hardwareDeviceSchema.parse(future)).toEqual(future);
	});

	test("rejects a v1.1 field with the wrong type", () => {
		expect(
			hardwareDeviceSchema.safeParse({ ...secureDevice, needs_repair: "yes" })
				.success
		).toBe(false);
		expect(
			hardwareDeviceSchema.safeParse({
				...secureDevice,
				capabilities: [{ name: "device.status" }],
			}).success
		).toBe(false);
	});

	test("lists devices with the node identity, tolerating old envelopes", async () => {
		const identity = { status: "ok", fingerprint: "7a7f-b905-d3ff-9444" };
		const current = recordingTarget(200, {
			devices: [secureDevice],
			node_identity: identity,
		});
		expect(await listDevicesWithIdentity(current.target)).toEqual({
			devices: [secureDevice],
			node_identity: identity,
		});
		const old = recordingTarget(200, [legacyDevice]);
		expect(await listDevicesWithIdentity(old.target)).toEqual({
			devices: [legacyDevice],
			node_identity: null,
		});
		const empty = recordingTarget(200, {});
		expect(await listDevices(empty.target)).toEqual([]);
		const broken = recordingTarget(200, {
			devices: [],
			node_identity: { fingerprint: "x" },
		});
		await expect(listDevices(broken.target)).rejects.toThrow();
	});
});

describe("pairing v2 response schemas", () => {
	test("begin requires the pairing id, node key and fingerprint", () => {
		const begin = {
			pairing_id: "oKGio6SlpqeoqaqrrK2urw",
			node_pub: "NDIHl_0nADtuPv4k3-tFu_Zuio5uKSFpHgFOa79Iq34",
			node_fingerprint: "7a7f-b905-d3ff-9444",
			expires_in: 180,
			extra: true,
		};
		expect(hardwarePairBeginResponseSchema.parse(begin)).toEqual(begin);
		const { node_pub: _omitted, ...missing } = begin;
		expect(hardwarePairBeginResponseSchema.safeParse(missing).success).toBe(
			false
		);
	});

	test("reveal requires a six-digit SAS", () => {
		const reveal = {
			sas: "394867",
			transcript_hash: "abCF23L8bomEkj98bvroIFN4cPaMjfS8ZJekhjyEuRY",
			device_fingerprint: "a59c-05e1-b559-f5b4",
		};
		expect(hardwarePairRevealResponseSchema.parse(reveal)).toEqual(reveal);
		expect(
			hardwarePairRevealResponseSchema.safeParse({ ...reveal, sas: "39486" })
				.success
		).toBe(false);
		expect(
			hardwarePairRevealResponseSchema.safeParse({ ...reveal, sas: 394_867 })
				.success
		).toBe(false);
	});

	test("confirm requires the relay token, seal and a valid device", () => {
		const confirm = {
			relay_token: "rhr_1",
			sealed_credentials: "o3R37nBZ",
			device: secureDevice,
		};
		expect(hardwarePairConfirmResponseSchema.parse(confirm)).toEqual(confirm);
		expect(
			hardwarePairConfirmResponseSchema.safeParse({
				...confirm,
				device: { device_id: "x" },
			}).success
		).toBe(false);
		expect(
			hardwarePairConfirmResponseSchema.safeParse({
				device: secureDevice,
				sealed_credentials: "o3R37nBZ",
			}).success
		).toBe(false);
	});

	test("identity reset accepts a count or a device list", () => {
		for (const devicesNeedingRepair of [2, ["a", "b"]]) {
			const reset = {
				node_fingerprint: "7a7f-b905-d3ff-9444",
				devices_needing_repair: devicesNeedingRepair,
			};
			expect(hardwareIdentityResetResponseSchema.parse(reset)).toEqual(reset);
		}
		expect(
			hardwareIdentityResetResponseSchema.safeParse({ node_fingerprint: "x" })
				.success
		).toBe(false);
	});
});

describe("pairing v2 requests", () => {
	test("posts each step to its route with the node bearer", async () => {
		const begin = recordingTarget(200, {
			pairing_id: "p",
			node_pub: "k",
			node_fingerprint: "f",
			expires_in: 180,
		});
		const body = {
			device_id: "d",
			device_type: "watch" as const,
			pairing_nonce: "00112233445566778899aabbccddeeff",
			device_pub: "k",
			device_commit: "c",
			key_source: "qr" as const,
			policy: "sas_press" as const,
		};
		await pairBegin(begin.target, body);
		expect(begin.calls).toEqual([
			{
				url: "https://node.example/api/hardware/pair/begin",
				method: "POST",
				body,
			},
		]);

		const reveal = recordingTarget(200, {
			sas: "394867",
			transcript_hash: "t",
			device_fingerprint: "f",
		});
		await pairReveal(reveal.target, { pairing_id: "p", device_rand: "r" });
		expect(reveal.calls[0]?.url).toBe(
			"https://node.example/api/hardware/pair/reveal"
		);

		const confirm = recordingTarget(200, {
			relay_token: "rhr_1",
			sealed_credentials: "s",
			device: secureDevice,
		});
		await pairConfirm(confirm.target, {
			pairing_id: "p",
			confirm_tag: "t",
			key_verification: "unverified",
		});
		expect(confirm.calls[0]?.body).toEqual({
			pairing_id: "p",
			confirm_tag: "t",
			key_verification: "unverified",
		});

		const cancel = recordingTarget(200, { ok: true });
		await pairCancel(cancel.target, { pairing_id: "p", reason: "mismatch" });
		expect(cancel.calls[0]?.url).toBe(
			"https://node.example/api/hardware/pair/cancel"
		);

		const reset = recordingTarget(200, {
			node_fingerprint: "f",
			devices_needing_repair: 0,
		});
		await resetHardwareIdentity(reset.target);
		expect(reset.calls[0]?.url).toBe(
			"https://node.example/api/hardware/identity/reset"
		);
	});

	test("surfaces the structured error code and status", async () => {
		const mismatch = recordingTarget(401, {
			error: { code: "commitment_mismatch", message: "commitment mismatch" },
		});
		const error = await pairReveal(mismatch.target, {
			pairing_id: "p",
			device_rand: "r",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(HardwareApiError);
		if (error instanceof HardwareApiError) {
			expect(error.status).toBe(401);
			expect(error.code).toBe("commitment_mismatch");
			expect(error.serverMessage).toBe("commitment mismatch");
		}
	});

	test("an older node's bare 404 has no code", async () => {
		const old = {
			url: "https://node.example",
			token: "node-token",
			fetch: async () => new Response("Not Found", { status: 404 }),
		};
		const error = await pairBegin(old, {
			device_id: "d",
			device_type: "necklace",
			pairing_nonce: "n",
			device_pub: "k",
			device_commit: "c",
			key_source: "ble",
			policy: "sas_press",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(HardwareApiError);
		if (error instanceof HardwareApiError) {
			expect(error.status).toBe(404);
			expect(error.code).toBeUndefined();
		}
	});
});
