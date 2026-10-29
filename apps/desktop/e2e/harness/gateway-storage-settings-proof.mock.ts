import type {
	OpenDialogOptions,
	SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJson,
	parseProofJsonRecord,
} from "../fixture-json.ts";
export interface GatewayStorageProgress {
	copied_bytes: number;
	phase: string;
	total_bytes: number;
}
export interface GatewayStorageDialogCall {
	kind: "open" | "save";
	options?: OpenDialogOptions | SaveDialogOptions;
	picked: string | null;
}
export interface GatewayStorageDestination {
	allowedApps: ProofJsonValue;
	allowHttp: ProofJsonValue;
	bucket?: ProofJsonValue;
	createdAt: string;
	endpoint?: ProofJsonValue;
	id: string;
	name?: ProofJsonValue;
	pathStyle: ProofJsonValue;
	prefix: ProofJsonValue;
	region?: ProofJsonValue;
}
export interface GatewayStorageOperation {
	action: string;
	createdAt: string;
	destinationId: string;
	id: string;
	scope: ProofJsonValue | undefined;
	status: string;
}
const StringSchema = z.string();
const JsonContainerSchema = z.union([
	z.record(z.string(), z.json()),
	z.array(z.json()),
]);

import type { Node } from "../../src/store/useNodeStore.ts";

export interface GatewayStorageCall {
	body?: ProofJsonValue;
	method: string;
	path: string;
}

export interface GatewayStorageTauriCall {
	args?: ProofJsonRecord;
	command: string;
}

export interface GatewayStorageState {
	apiCalls: GatewayStorageCall[];
	dataPath: {
		current: string;
		default: string;
		free_space_bytes: number;
		is_custom: boolean;
		size_bytes: number;
	};
	destinations: GatewayStorageDestination[];
	dialogCalls: GatewayStorageDialogCall[];
	dialogs: { open: (string | null)[]; save: (string | null)[] };
	failures: Record<
		string,
		{ message: string; remaining: number; status?: number }
	>;
	fetchCalls: string[];
	listeners: Map<string, (payload: GatewayStorageProgress) => void>;
	operations: GatewayStorageOperation[];
	policies: ProofJsonRecord[];
	records: ProofJsonRecord[];
	spaces: ProofJsonRecord[];
	tauriCalls: GatewayStorageTauriCall[];
	validationResult: {
		error?: string;
		ok: boolean;
		source_size_bytes: number;
		target_free_bytes: number;
	};
}

declare global {
	interface Window {
		__GATEWAY_STORAGE_PROOF__?: GatewayStorageState;
	}
}

const now = "2026-09-25T03:00:00.000Z";
const initialState = window.__GATEWAY_STORAGE_PROOF__;
const state: GatewayStorageState = initialState ?? {
	apiCalls: [],
	fetchCalls: [],
	dataPath: {
		current: "/Users/proof/.ryu-canary",
		default: "/Users/proof/.ryu",
		free_space_bytes: 8 * 1024 ** 3,
		is_custom: true,
		size_bytes: 1.5 * 1024 ** 3,
	},
	validationResult: {
		ok: true,
		source_size_bytes: 1.5 * 1024 ** 3,
		target_free_bytes: 8 * 1024 ** 3,
	},
	dialogs: { open: [], save: [] },
	failures: {},
	listeners: new Map(),
	operations: [],
	policies: [],
	records: [],
	destinations: [],
	dialogCalls: [],
	spaces: [
		{
			created_at: now,
			description: "Proof workspace",
			document_count: 3,
			id: "space-proof",
			name: "Research Space",
			retrieval_mode: "vector",
			updated_at: now,
		},
	],
	tauriCalls: [],
};

const search = new URLSearchParams(window.location.search);
if (!initialState && search.has("failDataPath")) {
	state.failures["GET /api/data-path"] = {
		message: "Core is not responding",
		remaining: 1,
	};
}
if (!initialState && search.has("failParseCapability")) {
	state.failures["GET /api/documents/parse/capability"] = {
		message: "Parser capability unavailable",
		remaining: 1,
	};
}
if (!initialState && search.has("failBackupOverview")) {
	state.failures["GET /api/backups"] = {
		message: "Backup service unavailable",
		remaining: 1,
	};
}

window.__GATEWAY_STORAGE_PROOF__ = state;

function getState(): GatewayStorageState {
	return window.__GATEWAY_STORAGE_PROOF__ ?? state;
}

export function useActiveNode(): Node {
	return {
		name: "Storage proof node",
		token: "storage-proof-token",
		url: "http://127.0.0.1:18980",
	};
}

export function useActiveNodeGetter(): () => Node {
	return useActiveNode;
}

export async function invoke(
	command: string,
	args?: ProofJsonRecord
): Promise<void> {
	const current = getState();
	current.tauriCalls.push({ command, args });
	const failure = current.failures[`tauri:${command}`];
	if (failure && failure.remaining > 0) {
		failure.remaining -= 1;
		throw new Error(failure.message);
	}
	return undefined;
}

export class Resource {
	readonly rid: number;

	constructor(rid: number) {
		this.rid = rid;
	}
}

export async function open(
	options?: OpenDialogOptions
): Promise<string | string[] | null> {
	const current = getState();
	const picked = current.dialogs.open.shift() ?? null;
	current.dialogCalls.push({ kind: "open", options, picked });
	return picked;
}

export async function save(
	options?: SaveDialogOptions
): Promise<string | null> {
	const current = getState();
	const picked = current.dialogs.save.shift() ?? null;
	current.dialogCalls.push({ kind: "save", options, picked });
	return picked;
}

export async function relaunch(): Promise<void> {
	getState().tauriCalls.push({ command: "relaunch" });
}

export async function listenWhenReady(
	eventName: string,
	handler: (event: { payload: GatewayStorageProgress }) => void
): Promise<() => void> {
	const current = getState();
	const listener = (payload: GatewayStorageProgress) => handler({ payload });
	current.listeners.set(eventName, listener);
	return () => current.listeners.delete(eventName);
}

export async function listen(
	eventName: string,
	handler: (event: { payload: GatewayStorageProgress }) => void
): Promise<() => void> {
	const current = getState();
	const listener = (payload: GatewayStorageProgress) => handler({ payload });
	current.listeners.set(eventName, listener);
	return () => current.listeners.delete(eventName);
}

export function emitProgress(payload: GatewayStorageProgress): void {
	getState().listeners.get("data-folder-progress")?.(payload);
}

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}

/** Core answers a destination or policy delete with an empty 204, and the
 *  shipping client rejects any body on those routes. */
function noContentResponse(): Response {
	return new Response(null, { status: 204 });
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function destination(
	id: string,
	body: ProofJsonRecord
): GatewayStorageDestination {
	return {
		allowedApps: body.allowedApps ?? [],
		allowHttp: body.allowHttp ?? false,
		bucket: body.bucket,
		createdAt: now,
		endpoint: body.endpoint,
		id,
		name: body.name,
		pathStyle: body.pathStyle ?? true,
		prefix: body.prefix ?? "ryu",
		region: body.region,
	};
}

function operation(
	action: string,
	scope: ProofJsonValue | undefined
): GatewayStorageOperation {
	const current = getState();
	const result = {
		createdAt: now,
		destinationId: "destination-proof",
		id: `${action}-proof-${current.operations.length + 1}`,
		scope,
		status: "completed",
		action,
	};
	current.operations.unshift(result);
	return result;
}

export function installGatewayStorageFetch(): () => void {
	const originalFetch = Object.assign(window.fetch.bind(window), window.fetch);
	window.fetch = Object.assign(
		async (
			input: Parameters<typeof window.fetch>[0],
			init?: Parameters<typeof window.fetch>[1]
		) => {
			const url =
				input instanceof Request
					? new URL(input.url)
					: new URL(String(input), window.location.href);
			getState().fetchCalls.push(url.toString());
			if (!url.pathname.startsWith("/api/")) {
				return originalFetch(input, init);
			}
			const current = getState();

			const method = (init?.method ?? "GET").toUpperCase();
			const path = `${url.pathname}${url.search}`;
			let body: ProofJsonRecord = {};
			let capturedBody: ProofJsonValue = {};
			const rawBody = StringSchema.safeParse(init?.body);
			if (rawBody.success) {
				try {
					capturedBody = parseProofJson(rawBody.data);
				} catch {
					capturedBody = {};
				}
				try {
					body = parseProofJsonRecord(rawBody.data);
				} catch {
					body = {};
				}
			}
			current.apiCalls.push({ body: capturedBody, method, path });
			const failureKey = `${method} ${url.pathname}`;
			const failure = current.failures[failureKey];
			if (failure && failure.remaining > 0) {
				failure.remaining -= 1;
				return jsonResponse({ error: failure.message }, failure.status ?? 500);
			}

			if (method === "GET" && url.pathname === "/api/data-path") {
				return jsonResponse(clone(current.dataPath));
			}
			if (method === "POST" && url.pathname === "/api/data-path/validate") {
				return jsonResponse(clone(current.validationResult));
			}
			if (method === "POST" && url.pathname === "/api/data-path/switch") {
				return jsonResponse({ ok: true, restart_required: true });
			}
			if (method === "POST" && url.pathname === "/api/data-path/reset") {
				return jsonResponse({ ok: true, restart_required: true });
			}
			if (method === "POST" && url.pathname === "/api/data-path/export") {
				return jsonResponse({ ok: true, bytes: 987_654 });
			}
			if (
				method === "GET" &&
				url.pathname === "/api/documents/parse/capability"
			) {
				return jsonResponse({
					available: true,
					builtin_extensions: [".txt", ".md"],
					extensions: [".txt", ".md"],
					max_input_bytes: 25 * 1024 ** 2,
				});
			}
			if (method === "GET" && url.pathname === "/api/spaces") {
				return jsonResponse({ spaces: clone(current.spaces) });
			}
			if (method === "GET" && url.pathname === "/api/backups") {
				return jsonResponse({
					destinations: clone(current.destinations),
					operations: clone(current.operations),
					policies: clone(current.policies),
				});
			}
			if (method === "POST" && url.pathname === "/api/backups/recovery-key") {
				return jsonResponse({
					recoveryKey: "proof-recovery-key-32-characters",
				});
			}
			if (url.pathname === "/api/backups/destinations" && method === "POST") {
				const id =
					current.destinations.length === 0
						? "destination-proof"
						: `destination-proof-${current.destinations.length + 1}`;
				const saved = destination(id, body);
				current.destinations = [saved, ...current.destinations];
				return jsonResponse(saved);
			}
			const destinationMatch = url.pathname.match(
				/^\/api\/backups\/destinations\/([^/]+)$/
			);
			if (destinationMatch && method === "PUT") {
				const id = decodeURIComponent(destinationMatch[1] ?? "");
				const saved = destination(id, body);
				current.destinations = current.destinations.map((entry) =>
					entry.id === id ? saved : entry
				);
				return jsonResponse(saved);
			}
			if (destinationMatch && method === "DELETE") {
				const id = decodeURIComponent(destinationMatch[1] ?? "");
				current.destinations = current.destinations.filter(
					(entry) => entry.id !== id
				);
				return noContentResponse();
			}
			if (
				method === "POST" &&
				/^\/api\/backups\/destinations\/[^/]+\/test$/.test(url.pathname)
			) {
				return jsonResponse({ ok: true });
			}
			if (
				method === "GET" &&
				/^\/api\/backups\/destinations\/[^/]+\/backups$/.test(url.pathname)
			) {
				return jsonResponse(clone(current.records));
			}
			if (method === "POST" && url.pathname === "/api/backups/policies") {
				const existing = current.policies.find(
					(policy) =>
						policy.destinationId === body.destinationId &&
						JSON.stringify(policy.scope) === JSON.stringify(body.scope)
				);
				const saved = {
					...body,
					id: existing?.id ?? `policy-${current.policies.length + 1}`,
				};
				current.policies = existing
					? current.policies.map((policy) =>
							policy.id === existing.id ? saved : policy
						)
					: [...current.policies, saved];
				return jsonResponse(saved);
			}
			if (
				method === "DELETE" &&
				url.pathname.startsWith("/api/backups/policies/")
			) {
				const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
				current.policies = current.policies.filter(
					(policy) => policy.id !== id
				);
				return noContentResponse();
			}
			if (method === "POST" && url.pathname === "/api/backups/runs") {
				return jsonResponse(operation("backup", body.scope));
			}
			if (method === "POST" && url.pathname === "/api/backups/restore") {
				const backupId = StringSchema.safeParse(body.backupId).data ?? null;
				const record = current.records.find((entry) => entry.id === backupId);
				const scope =
					record && JsonContainerSchema.safeParse(record.scope).success
						? record.scope
						: { kind: "node" };
				return jsonResponse(operation("restore", scope));
			}
			return jsonResponse(
				{ error: `Unexpected proof request: ${method} ${path}` },
				404
			);
		},
		window.fetch
	);

	return () => {
		window.fetch = originalFetch;
	};
}
