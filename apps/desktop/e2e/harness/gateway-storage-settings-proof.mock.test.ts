import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { parseProofJsonRecord } from "../fixture-json.ts";
import type { GatewayStorageProgress } from "./gateway-storage-settings-proof.mock.ts";

GlobalRegistrator.register();
const mock = await import("./gateway-storage-settings-proof.mock.ts");
let restoreFetch: ReturnType<typeof mock.installGatewayStorageFetch> = () =>
	undefined;

beforeEach(() => {
	const state = window.__GATEWAY_STORAGE_PROOF__;
	if (!state) {
		throw new Error("Storage fixture was not installed");
	}
	state.apiCalls = [];
	state.operations = [];
	state.records = [];
	state.failures = {};
	state.tauriCalls = [];
	state.listeners.clear();
	restoreFetch = mock.installGatewayStorageFetch();
});
afterEach(() => {
	restoreFetch();
});

test("captures negative JSON domain values without replacing them", async () => {
	await window.fetch("http://localhost/api/backups/runs", {
		method: "POST",
		body: '["invalid request"]',
	});
	expect(window.__GATEWAY_STORAGE_PROOF__?.apiCalls.at(-1)?.body).toEqual([
		"invalid request",
	]);
	expect(
		window.__GATEWAY_STORAGE_PROOF__?.operations.at(-1)?.scope
	).toBeUndefined();
});

test("retains captured hostile own property names without prototype mutation", async () => {
	await window.fetch("http://localhost/api/backups/runs", {
		method: "POST",
		body: '{"__proto__":{"polluted":true},"scope":{"kind":"node"}}',
	});
	const captured = parseProofJsonRecord(
		JSON.stringify(window.__GATEWAY_STORAGE_PROOF__?.apiCalls.at(-1)?.body)
	);
	expect(Object.hasOwn(captured, "__proto__")).toBe(true);
	expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
	expect(window.__GATEWAY_STORAGE_PROOF__?.operations.at(-1)?.scope).toEqual({
		kind: "node",
	});
});

test("preserves malformed JSON fallback and consumed failure counters", async () => {
	const state = window.__GATEWAY_STORAGE_PROOF__;
	if (!state) {
		throw new Error("Storage fixture was not installed");
	}
	state.failures["POST /api/backups/runs"] = {
		message: "Try again",
		remaining: 1,
		status: 403,
	};
	const first = await window.fetch("http://localhost/api/backups/runs", {
		method: "POST",
		body: "{",
	});
	expect(first.status).toBe(403);
	expect(state.apiCalls.at(-1)?.body).toEqual({});
	const second = await window.fetch("http://localhost/api/backups/runs", {
		method: "POST",
		body: "{",
	});
	expect(second.status).toBe(200);
	expect(state.operations).toHaveLength(1);
});

test("retains negative restore container scopes and node fallback for scalar scopes", async () => {
	const state = window.__GATEWAY_STORAGE_PROOF__;
	if (!state) {
		throw new Error("Storage fixture was not installed");
	}
	state.records = [
		{ id: "array", scope: ["invalid scope"] },
		{ id: "scalar", scope: "invalid scope" },
	];
	await window.fetch("http://localhost/api/backups/restore", {
		method: "POST",
		body: '{"backupId":"array"}',
	});
	expect(state.operations[0]?.scope).toEqual(["invalid scope"]);
	await window.fetch("http://localhost/api/backups/restore", {
		method: "POST",
		body: '{"backupId":"scalar"}',
	});
	expect(state.operations[0]?.scope).toEqual({ kind: "node" });
});

test("delivers the checked progress fixture to registered listeners", async () => {
	const progress = { phase: "copy", copied_bytes: 512, total_bytes: 1024 };
	const received: GatewayStorageProgress[] = [];
	const unlisten = await mock.listenWhenReady(
		"data-folder-progress",
		(event) => {
			received.push(event.payload);
		}
	);
	mock.emitProgress(progress);
	expect(received).toEqual([progress]);
	unlisten();
	expect(window.__GATEWAY_STORAGE_PROOF__?.listeners.size).toBe(0);
});

test("records native command arguments and keeps undefined completion", async () => {
	const args = { to: "/Volumes/Ryu Data", moveSource: false };
	expect(await mock.invoke("migrate_data_folder", args)).toBeUndefined();
	expect(window.__GATEWAY_STORAGE_PROOF__?.tauriCalls).toEqual([
		{ command: "migrate_data_folder", args },
	]);
});
