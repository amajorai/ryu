import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const folders: string[] = [];
mock.module("@/src/store/useWorkspaceStore.ts", () => ({
	useWorkspaceStore: () => (folder: string) => folders.push(folder),
}));
const { useAutoThreadImport } = await import(
	"@/src/hooks/useAutoThreadImport.ts"
);
const { useAutoSetupImport } = await import(
	"@/src/hooks/useAutoSetupImport.ts"
);
const refreshed = mock(() => undefined);
type Kind = "threads" | "setup";
type Call = { scope: string; method: string; path: string; body: unknown };
const calls: Call[] = [];
const persisted = new Map<string, unknown[]>();
const gates = new Map<
	string,
	{ promise: Promise<void>; release: () => void }
>();
const failures = new Set<string>();
const unexpected: string[] = [];
let sharedNativeIds = false;
let failedSetupOutcome = false;
function scope(target: ApiTarget) {
	return `${new URL(target.url).pathname}|${target.token}|${target.userJwt ?? ""}`;
}
function hold(target: ApiTarget, path: string) {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const key = `${scope(target)}:${path}`;
	gates.set(key, { promise, release });
	return key;
}
function release(key: string) {
	const gate = gates.get(key);
	if (!gate) throw new Error("No actual held request");
	gates.delete(key);
	gate.release();
}
const server: ReturnType<typeof Bun.serve> = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const node = url.pathname.split("/")[1]!;
		const path = url.pathname.slice(node.length + 1);
		const token =
			request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
		const jwt = request.headers.get("x-ryu-user-jwt") ?? "";
		const owner = `/${node}|${token}|${jwt}`;
		const body: unknown =
			request.method === "POST" ? await request.json() : null;
		const call = { scope: owner, method: request.method, path, body };
		calls.push(call);
		const gate = gates.get(`${owner}:${path}`);
		if (gate) await gate.promise;
		if (failures.has(`${owner}:${path}`))
			return NativeResponse.json(
				{ error: "Owned import refused" },
				{ status: 503 }
			);
		const id = sharedNativeIds ? "same-native-id" : `${owner}:native-id`;
		const cwd = sharedNativeIds
			? "/shared/project"
			: `/${node}/${token}/${jwt}/project`;
		if (request.method === "GET" && path === "/api/agent-sync/profiles")
			return NativeResponse.json({ profiles: [] });
		if (request.method === "GET" && path === "/api/agents/codex/threads")
			return NativeResponse.json({
				supported: true,
				engine: "codex",
				threads: [
					{
						id,
						engine: "codex",
						title: "Owned thread",
						cwd,
						updated_at: 1,
						message_count: 1,
					},
				],
			});
		if (request.method === "GET" && path === "/api/workspace/list")
			return NativeResponse.json({
				home: cwd,
				path: cwd,
				parent: null,
				entries: [],
			});
		if (request.method === "POST" && path === "/api/import/scan") {
			const data = body as { path: string };
			return NativeResponse.json({
				root: data.path,
				items: data.path.endsWith(".claude")
					? [
							{
								id,
								kind: "instructions",
								title: "Owned instructions",
								content_revision: "c".repeat(64),
							},
						]
					: [],
				warnings: [],
			});
		}
		if (
			request.method === "POST" &&
			(path === "/api/agents/codex/threads/import" ||
				path === "/api/import/run")
		) {
			if (path === "/api/import/run" && failedSetupOutcome)
				return NativeResponse.json({
					root: cwd,
					results: [
						{
							id,
							kind: "instructions",
							status: "failed",
							title: "Owned instructions",
							detail: "Preference write refused",
						},
					],
				});
			const prior = persisted.get(owner) ?? [];
			const already = prior.some(
				(row) => JSON.stringify(row) === JSON.stringify(body)
			);
			if (!already) persisted.set(owner, [...prior, body]);
			if (path.endsWith("threads/import"))
				return NativeResponse.json({
					conversation_id: `${owner}:conversation`,
					already_imported: already,
					cwd,
					message_count: 1,
				});
			return NativeResponse.json({
				root: cwd,
				results: [
					{
						id,
						kind: "instructions",
						status: already ? "skipped" : "imported",
						title: "Owned instructions",
						folder_path: cwd,
						content_revision: "c".repeat(64),
						already_exists: already,
					},
				],
			});
		}
		unexpected.push(`${request.method} ${url.href}`);
		return NativeResponse.json(
			{ error: "Unexpected fixture request" },
			{ status: 503 }
		);
	},
});
const a: ApiTarget = {
	url: `${server.url}a`,
	token: "node-a-token",
	userJwt: "user-a-jwt",
};
function b(rotation: string): ApiTarget {
	return rotation === "url"
		? { ...a, url: `${server.url}b` }
		: rotation === "token"
			? { ...a, token: "node-b-token" }
			: { ...a, userJwt: "user-b-jwt" };
}
const agent = { id: "codex", engine: "codex", builtIn: true } as AgentSummary;
function Threads({ target }: { target: ApiTarget }) {
	useAutoThreadImport({ agents: [agent], target, onImported: refreshed });
	return null;
}
function Setup({ target }: { target: ApiTarget }) {
	useAutoSetupImport({ target, onImported: refreshed });
	return null;
}
let root = createRoot(document.createElement("div"));
let clock = 100_000;
const now = spyOn(Date, "now").mockImplementation(() => clock);
async function render(kind: Kind, target: ApiTarget) {
	await act(async () =>
		root.render(
			kind === "threads" ? (
				<Threads target={target} />
			) : (
				<Setup target={target} />
			)
		)
	);
}
async function focus() {
	clock += 31_000;
	await act(async () => window.dispatchEvent(new Event("focus")));
}
async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await settle();
	expect(predicate()).toBe(true);
}
function writePath(kind: Kind) {
	return kind === "threads"
		? "/api/agents/codex/threads/import"
		: "/api/import/run";
}
function listPath(kind: Kind) {
	return kind === "threads" ? "/api/agents/codex/threads" : "/api/import/scan";
}
function writes() {
	return calls.filter(
		(call) =>
			call.path === "/api/agents/codex/threads/import" ||
			call.path === "/api/import/run"
	);
}
beforeEach(() => {
	sharedNativeIds = false;
	failedSetupOutcome = false;
	localStorage.clear();
	localStorage.setItem("ryu:auto-import-agent-setup", "true");
	calls.length = 0;
	folders.length = 0;
	unexpected.length = 0;
	persisted.clear();
	refreshed.mockClear();
	failures.clear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const gate of gates.values()) gate.release();
	gates.clear();
	await settle();
	expect(unexpected).toEqual([]);
	root = createRoot(document.createElement("div"));
});
afterAll(() => {
	now.mockRestore();
	server.stop(true);
	GlobalRegistrator.unregister();
});
for (const kind of ["threads", "setup"] as const) {
	test(`${kind}: actual authenticated import refusal retries identical intent then remount reads scoped suppression`, async () => {
		const path = writePath(kind);
		failures.add(`${scope(a)}:${path}`);
		await render(kind, a);
		await focus();
		await until(() => writes().length === 1);
		await settle();
		expect(persisted.size).toBe(0);
		expect(folders).toEqual([]);
		expect(refreshed).not.toHaveBeenCalled();
		failures.clear();
		await focus();
		await until(() => persisted.has(scope(a)));
		await settle();
		expect(writes()).toHaveLength(2);
		expect(writes()[0]!.body).toEqual(writes()[1]!.body);
		expect(writes().map((call) => call.scope)).toEqual([scope(a), scope(a)]);
		expect(folders).toEqual([`/a/${a.token}/${a.userJwt}/project`]);
		expect(refreshed).toHaveBeenCalledTimes(1);
		await act(async () => root.render(null));
		await render(kind, a);
		await focus();
		await settle();
		expect(writes()).toHaveLength(2);
	});
	for (const rotation of ["url", "token", "jwt", "aba", "unmount"])
		for (const phase of ["profiles", "listing", "write"] as const) {
			test(`${kind}: held ${phase} cannot publish or cross-write after ${rotation}`, async () => {
				const path =
					phase === "profiles"
						? "/api/agent-sync/profiles"
						: phase === "listing"
							? listPath(kind)
							: writePath(kind);
				const key = hold(a, path);
				await render(kind, a);
				await focus();
				await until(() =>
					calls.some((call) => call.scope === scope(a) && call.path === path)
				);
				const next = b(rotation);
				if (rotation === "unmount") await act(async () => root.render(null));
				else {
					await render(kind, next);
					if (rotation === "aba") await render(kind, a);
				}
				release(key);
				await settle();
				// An accepted already-in-flight write may persist to A. It must not update
				// retired UI, register a folder or mark any current authority as seen.
				expect(folders).toEqual([]);
				expect(refreshed).not.toHaveBeenCalled();
				expect(writes()).toHaveLength(phase === "write" ? 1 : 0);
				if (phase === "write") expect(writes()[0]!.scope).toBe(scope(a));
				if (rotation !== "unmount") {
					const current = rotation === "aba" ? a : next;
					await focus();
					await until(() => writes().length === (phase === "write" ? 2 : 1));
					await settle();
					expect(writes().at(-1)!.scope).toBe(scope(current));
					expect(folders).toEqual([
						`/${new URL(current.url).pathname.slice(1)}/${current.token}/${current.userJwt}/project`,
					]);
				}
			});
		}
}

for (const kind of ["threads", "setup"] as const) {
	for (const rotation of ["url", "token", "jwt"])
		test(`${kind}: equal native locators are imported independently for ${rotation} authority`, async () => {
			sharedNativeIds = true;
			await render(kind, a);
			await focus();
			await until(() => persisted.has(scope(a)));
			await settle();
			const next = b(rotation);
			await render(kind, next);
			await focus();
			await until(() => persisted.has(scope(next)));
			await settle();
			expect(writes().map((call) => call.scope)).toEqual([
				scope(a),
				scope(next),
			]);
			expect(writes()[0]!.body).toEqual(writes()[1]!.body);
			expect(folders).toEqual(["/shared/project", "/shared/project"]);
			expect(refreshed).toHaveBeenCalledTimes(2);
			const keys = Array.from(
				{ length: localStorage.length },
				(_, index) => localStorage.key(index)!
			);
			expect(
				keys.some((key) => key.includes(a.token!) || key.includes(a.userJwt!))
			).toBe(false);
		});
	test(`${kind}: an unowned legacy seen record cannot suppress this Core import`, async () => {
		sharedNativeIds = true;
		const namespace =
			kind === "threads"
				? "ryu:auto-imported-thread-ids"
				: "ryu:auto-imported-setup-ids";
		const legacy = JSON.stringify([
			kind === "threads"
				? "codex:same-native-id"
				: "/shared/project/.claude:same-native-id",
		]);
		localStorage.setItem(namespace, legacy);
		await render(kind, a);
		await focus();
		await until(() => persisted.has(scope(a)));
		await settle();
		expect(writes()).toHaveLength(1);
		expect(localStorage.getItem(namespace)).toBe(legacy);
	});
	test(`${kind}: missing WebCrypto retains current-owner in-memory suppression without crashing`, async () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: undefined,
		});
		try {
			await render(kind, a);
			await focus();
			await until(() => persisted.has(scope(a)));
			await settle();
			await focus();
			await settle();
			expect(writes()).toHaveLength(1);
			expect(refreshed).toHaveBeenCalledTimes(1);
		} finally {
			if (original) Object.defineProperty(globalThis, "crypto", original);
		}
	});
}

for (const kind of ["threads", "setup"] as const) {
	test(`${kind}: switching the General opt-in off during a genuine held read stops unsent import`, async () => {
		const key = hold(a, listPath(kind));
		await render(kind, a);
		await focus();
		await until(() => calls.some((call) => call.path === listPath(kind)));
		localStorage.setItem(
			kind === "threads"
				? "ryu:auto-import-agent-threads"
				: "ryu:auto-import-agent-setup",
			"false"
		);
		release(key);
		await settle();
		expect(writes()).toEqual([]);
		expect(folders).toEqual([]);
		expect(refreshed).not.toHaveBeenCalled();
	});
	test(`${kind}: an equivalent target rerender cannot overlap its held profile lookup`, async () => {
		const key = hold(a, "/api/agent-sync/profiles");
		await render(kind, a);
		await focus();
		await until(() =>
			calls.some((call) => call.path === "/api/agent-sync/profiles")
		);
		await render(kind, { ...a, url: `${a.url}/` });
		await focus();
		await settle();
		expect(
			calls.filter((call) => call.path === "/api/agent-sync/profiles")
		).toHaveLength(1);
		release(key);
		await until(() => persisted.has(scope(a)));
		await settle();
		expect(writes()).toHaveLength(1);
		expect(refreshed).toHaveBeenCalledTimes(1);
	});
}

test("setup: a genuine HTTP200 failed instruction outcome remains unseen and retries the identical selection", async () => {
	failedSetupOutcome = true;
	await render("setup", a);
	await focus();
	await until(() => writes().length === 1);
	await settle();
	expect(persisted.size).toBe(0);
	expect(folders).toEqual([]);
	expect(refreshed).not.toHaveBeenCalled();
	failedSetupOutcome = false;
	await focus();
	await until(() => persisted.has(scope(a)));
	await settle();
	expect(writes()).toHaveLength(2);
	expect(writes()[0]!.body).toEqual(writes()[1]!.body);
	expect(folders).toEqual([`/a/${a.token}/${a.userJwt}/project`]);
	expect(refreshed).toHaveBeenCalledTimes(1);
});
