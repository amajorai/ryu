import { expect, test } from "bun:test";
import {
	deleteVaultAuditDevice,
	hashVaultAuditIdentifier,
	listVaultAuditDevices,
	putVaultAuditDevice,
} from "./audit-devices.ts";

interface Seen {
	auth: string | null;
	body: unknown;
	method: string;
	url: string;
}

function fakeCore(reply: unknown, status = 200) {
	const seen: Seen[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push({
			url: `${url.pathname}${url.search}`,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			auth: new Headers(init?.headers).get("authorization"),
		});
		return Promise.resolve(Response.json(reply, { status }));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

// `AuditDevice` plus the `health` the listing adds (`DeviceHealth` skips
// absent timestamps), rendered with RFC 3339 `…At` fields.
const fileDevice = {
	id: "local",
	kind: "file",
	enabled: true,
	description: "JSON lines",
	hmacFields: true,
	options: { path: "/var/lib/ryu/audit/vault.log", maxBytes: 10_485_760 },
	source: "api",
};

test("devices list with their delivery health and the fail-closed flag", async () => {
	const { seen, target } = fakeCore({
		devices: [
			{ ...fileDevice, health: { failing: false } },
			{
				id: "siem",
				kind: "http",
				enabled: false,
				description: "",
				hmacFields: false,
				options: {
					url: "https://siem.example/ingest",
					secretRef: "secret:SIEM",
				},
				source: "declarative",
				health: {
					failing: true,
					lastErrorAt: "2030-01-01T00:00:00+00:00",
					lastError: "connection refused",
				},
			},
		],
		failClosed: true,
	});
	const listing = await listVaultAuditDevices(target);
	expect(seen[0]).toMatchObject({
		url: "/api/vault/audit/devices",
		method: "GET",
		auth: "Bearer node-token",
	});
	expect(listing.failClosed).toBe(true);
	expect(
		listing.devices.map((device) => [device.id, device.health.failing])
	).toEqual([
		["local", false],
		["siem", true],
	]);
	expect(listing.devices[1]?.health.lastError).toBe("connection refused");
});

test("a listing with an unknown device kind is rejected", async () => {
	const { target } = fakeCore({
		devices: [{ ...fileDevice, kind: "kafka", health: { failing: false } }],
		failClosed: false,
	});
	await expect(listVaultAuditDevices(target)).rejects.toThrow();
});

test("put sends the device body and returns the saved device", async () => {
	const { seen, target } = fakeCore({ ok: true, device: fileDevice });
	const saved = await putVaultAuditDevice(target, "local/1", {
		kind: "file",
		options: { path: "/var/lib/ryu/audit/vault.log" },
		hmacFields: true,
	});
	expect(saved.device.kind).toBe("file");
	expect(seen[0]).toMatchObject({
		url: "/api/vault/audit/devices/local%2F1",
		method: "PUT",
		body: {
			kind: "file",
			options: { path: "/var/lib/ryu/audit/vault.log" },
			hmacFields: true,
		},
	});
});

test("delete and audit-hash reach their routes", async () => {
	const deleted = fakeCore({ ok: true });
	expect(await deleteVaultAuditDevice(deleted.target, "siem")).toEqual({
		ok: true,
	});
	expect(deleted.seen[0]).toMatchObject({
		url: "/api/vault/audit/devices/siem",
		method: "DELETE",
	});
	const hashed = fakeCore({ device: "siem", hash: "hmac-sha256:ab12" });
	const result = await hashVaultAuditIdentifier(
		hashed.target,
		"siem",
		"rvt.acc"
	);
	expect(result.hash).toBe("hmac-sha256:ab12");
	expect(hashed.seen[0]).toMatchObject({
		url: "/api/vault/sys/audit-hash",
		method: "POST",
		body: { device: "siem", input: "rvt.acc" },
	});
});

test("a missing device surfaces Core's 404", async () => {
	const { target } = fakeCore(
		{ error: { code: "vault_not_found", message: "audit device `x`" } },
		404
	);
	await expect(deleteVaultAuditDevice(target, "x")).rejects.toMatchObject({
		status: 404,
	});
});
