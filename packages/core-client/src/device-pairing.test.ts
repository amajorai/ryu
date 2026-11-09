import { describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	approvePendingDevicePairings,
	listPendingDevicePairings,
} from "./device-pairing.ts";

function device(deviceId: string, state: "active" | "pending") {
	return {
		always_allowed: [],
		app: "ryu",
		device_id: deviceId,
		foreground: false,
		label: `Phone ${deviceId}`,
		last_seen_ms: 0,
		paired_at_ms: 0,
		platform: "ios",
		state,
	};
}

function fakeCore(devices: ReturnType<typeof device>[]) {
	const requests: { method: string; url: string }[] = [];
	const target: ApiTarget = {
		fetch: (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			requests.push({ method, url });
			const approve = url.match(/devices\/([^/]+)\/approve-pair$/);
			if (approve) {
				const id = decodeURIComponent(approve[1] ?? "");
				const row = devices.find((d) => d.device_id === id);
				if (row) {
					row.state = "active";
				}
				return Promise.resolve(
					Response.json({ device_id: id, state: "active" })
				);
			}
			return Promise.resolve(Response.json({ devices, principal_id: "owner" }));
		},
		token: "node-token",
		url: "http://127.0.0.1:7979/",
	};
	return { devices, requests, target };
}

describe("listPendingDevicePairings", () => {
	test("lists only the devices awaiting host approval", async () => {
		const core = fakeCore([device("a", "active"), device("b", "pending")]);
		const pending = await listPendingDevicePairings(core.target);
		expect(pending.map((d) => d.device_id)).toEqual(["b"]);
	});
});

describe("approvePendingDevicePairings", () => {
	test("approves the chosen pending devices and skips the rest", async () => {
		const core = fakeCore([
			device("a", "active"),
			device("b", "pending"),
			device("c", "pending"),
		]);
		const approved = await approvePendingDevicePairings(core.target, [
			"a",
			"b",
			"gone",
		]);
		expect(approved).toEqual(["b"]);
		expect(core.devices.map((d) => d.state)).toEqual([
			"active",
			"active",
			"pending",
		]);
		const posts = core.requests.filter((r) => r.method === "POST");
		expect(posts.map((r) => r.url)).toEqual([
			"http://127.0.0.1:7979/api/device-tools/devices/b/approve-pair",
		]);
	});
});
