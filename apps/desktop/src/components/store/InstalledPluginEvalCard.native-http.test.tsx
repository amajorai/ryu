import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	PluginEvalOverview,
	PluginEvalRunResult,
} from "@/src/lib/api/plugins.ts";
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { InstalledPluginEvalCard } = await import(
	"@/src/components/store/InstalledPluginEvalCard.tsx"
);
type Call = { owner: string; method: string; path: string; body: unknown };
const calls: Call[] = [];
const stored = new Map<string, PluginEvalRunResult[]>();
const unexpected: string[] = [];
const held = new Map<string, { promise: Promise<void>; release: () => void }>();
const refusals = new Map<string, number>();
const appId = "com.example.agent";
const otherAppId = "com.example.other-agent";
function owner(target: ApiTarget) {
	return `${new URL(target.url).pathname}|${target.token}|${target.userJwt ?? ""}`;
}
function suite(scope: string, id = appId): PluginEvalOverview {
	return {
		artifactKind: "plugin",
		pluginId: id,
		suite: {
			caseCount: 1,
			cases: [
				{
					graderCount: 1,
					id: "owned-case",
					maxTurns: 2,
					name: "Owned check",
					path: "evals/owned-case",
					runs: 1,
					tags: [],
					timeoutSeconds: 30,
				},
			],
			directory: "evals",
			graderCount: 1,
			rulesetVersion: "ryu-plugin-evals-1",
			schemaVersion: "1",
			status: "ready",
			supportedGraders: ["contains"],
			unsupportedGraders: [],
			issues: [
				{
					message: `${scope}:owned-suite`,
					code: "fixture-owner",
					severity: "info",
					path: "evals/owned-case/prompt.md",
				},
			],
		},
	};
}
function result(scope: string, id = appId): PluginEvalRunResult {
	return {
		artifactKind: "plugin",
		pluginId: id,
		baseline: { reason: "Do not disable live plugins", status: "not_run" },
		cases: [
			{
				id: "owned-case",
				name:
					id === appId ? `${scope}:owned-case` : `${scope}:other-plugin-case`,
				failed: 1,
				passed: 0,
				runs: [
					{
						id: "attempt-1",
						durationMs: 25,
						error: null,
						graders: [
							{
								detail: "Observed partial fixture response",
								executed: true,
								id: "contains",
								score: 0.7,
								status: "fail",
								type: "contains",
							},
						],
						responsePreview: "Partial response",
						score: 0.7,
						status: "failed",
						toolCalls: [],
					},
				],
				score: 0.7,
				skipped: 0,
				status: "failed",
			},
		],
		evidenceLevel: "plugin-agent",
		runId: `${scope}:real-run`,
		schemaVersion: "1",
		score: 0.7,
		status: "failed",
		suite: suite(scope, id).suite,
	};
}
const server: ReturnType<typeof Bun.serve> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const node = url.pathname.split("/")[1]!;
		const path = url.pathname.slice(node.length + 1);
		const scope = `/${node}|${request.headers.get("authorization")?.replace("Bearer ", "")}|${request.headers.get("x-ryu-user-jwt") ?? ""}`;
		const body: unknown =
			request.method === "POST" ? await request.json() : null;
		calls.push({ owner: scope, method: request.method, path, body });
		if (
			!(
				request.method === "GET" &&
				path === "/api/plugins/evals" &&
				[appId, otherAppId].includes(url.searchParams.get("id") ?? "")
			) &&
			!(
				request.method === "POST" &&
				path === "/api/plugins/evals/run" &&
				[appId, otherAppId].some(
					(id) => JSON.stringify(body) === JSON.stringify({ id })
				)
			)
		) {
			unexpected.push(`${request.method} ${url.href} ${JSON.stringify(body)}`);
			return NativeResponse.json(
				{ error: { message: "Unexpected fixture contract" } },
				{ status: 503 }
			);
		}
		const key = `${scope}:${request.method}`;
		const gate = held.get(key);
		if (gate) await gate.promise;
		const refusal = refusals.get(key);
		if (refusal)
			return NativeResponse.json(
				{ error: { message: "Owned eval run refused" } },
				{ status: refusal }
			);
		if (request.method === "GET")
			return NativeResponse.json(
				suite(scope, url.searchParams.get("id") ?? appId)
			);
		const value = result(scope, (body as { id: string }).id);
		stored.set(scope, [...(stored.get(scope) ?? []), value]);
		return NativeResponse.json(value);
	},
});
const a: ApiTarget = {
	url: `${server.url}a`,
	token: "a-node-token",
	userJwt: "a-user-jwt",
};
function next(rotation: string): ApiTarget {
	return rotation === "url"
		? { ...a, url: `${server.url}b` }
		: rotation === "token"
			? { ...a, token: "b-node-token" }
			: { ...a, userJwt: "b-user-jwt" };
}
function hold(target: ApiTarget, method: string) {
	const key = `${owner(target)}:${method}`;
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	held.set(key, { promise, release });
	return key;
}
function release(key: string) {
	const gate = held.get(key);
	if (!gate) throw new Error("No actual held request");
	held.delete(key);
	gate.release();
}
let client = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
let container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
async function render(target: ApiTarget, id = appId) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<InstalledPluginEvalCard appId={id} target={target} />
			</QueryClientProvider>
		)
	);
}
function runButton() {
	const button = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((item) =>
		/^(Run evals|Running)$/.test(item.textContent?.trim() ?? "")
	);
	if (!button) throw new Error("Actual Run evals button missing");
	return button;
}
function click(button = runButton()) {
	return act(async () => button.click());
}
async function settle() {
	await act(async () => {
		await Bun.sleep(25);
	});
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) await settle();
	expect(predicate()).toBe(true);
}
function posts() {
	return calls.filter((call) => call.method === "POST");
}
beforeEach(() => {
	localStorage.clear();
	calls.length = 0;
	stored.clear();
	unexpected.length = 0;
	refusals.clear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const gate of held.values()) gate.release();
	held.clear();
	await settle();
	expect(unexpected).toEqual([]);
	client.clear();
	container.remove();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterAll(() => {
	server.stop(true);
	GlobalRegistrator.unregister();
});
test("real card renders acknowledged failed-score evidence and same-authority equivalent targets preserve it", async () => {
	await render(a);
	await until(() => !runButton().disabled);
	expect(container.textContent).toContain(`${owner(a)}:owned-suite`);
	await click();
	await until(() => stored.has(owner(a)));
	await settle();
	expect(posts()).toEqual([
		{
			owner: owner(a),
			method: "POST",
			path: "/api/plugins/evals/run",
			body: { id: appId },
		},
	]);
	expect(
		container.querySelector('[data-testid="plugin-evals-result"]')?.textContent
	).toContain("70/100");
	expect(container.textContent).toContain(`${owner(a)}:owned-case`);
	expect(container.textContent).toContain("failed · plugin-agent");
	await render({ ...a });
	expect(container.textContent).toContain(`${owner(a)}:owned-case`);
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
});
test("run503 does not fabricate evidence and identical retry submits one current authenticated request", async () => {
	await render(a);
	await until(() => !runButton().disabled);
	refusals.set(`${owner(a)}:POST`, 503);
	await click();
	await until(() => container.querySelector('[role="alert"]') !== null);
	expect(container.textContent).toContain("Owned eval run refused");
	expect(stored.size).toBe(0);
	expect(
		container.querySelector('[data-testid="plugin-evals-result"]')
	).toBeNull();
	expect(runButton().disabled).toBe(false);
	refusals.clear();
	await click();
	await until(() => stored.has(owner(a)));
	await settle();
	expect(posts()).toHaveLength(2);
	expect(posts()[0]).toEqual(posts()[1]);
	expect(container.textContent).toContain(`${owner(a)}:owned-case`);
	expect(container.querySelector('[role="alert"]')).toBeNull();
});
for (const rotation of ["url", "token", "jwt"])
	test(`suite and completed evidence are scoped to the actual ${rotation} authority`, async () => {
		await render(a);
		await until(() => !runButton().disabled);
		await click();
		await until(() => stored.has(owner(a)));
		await settle();
		const b = next(rotation);
		const key = hold(b, "GET");
		await render(b);
		await settle();
		expect(runButton().disabled).toBe(true);
		expect(container.textContent).not.toContain(`${owner(a)}:owned-suite`);
		expect(container.textContent).not.toContain(`${owner(a)}:owned-case`);
		release(key);
		await until(() => !runButton().disabled);
		expect(container.textContent).toContain(`${owner(b)}:owned-suite`);
		await click();
		await until(() => stored.has(owner(b)));
		await settle();
		expect(posts().map((call) => call.owner)).toEqual([owner(a), owner(b)]);
		expect(container.textContent).toContain(`${owner(b)}:owned-case`);
	});
for (const rotation of ["url", "token", "jwt", "aba", "unmount"])
	for (const status of [200, 503])
		test(`held A run${status} cannot publish evidence/error or unlock ${rotation}`, async () => {
			await render(a);
			await until(() => !runButton().disabled);
			const key = hold(a, "POST");
			await click();
			await until(() => posts().length === 1);
			if (status === 503) refusals.set(`${owner(a)}:POST`, 503);
			let current = next(rotation);
			if (rotation === "unmount") await act(async () => root.render(null));
			else {
				await render(current);
				if (rotation === "aba") {
					current = a;
					await render(a);
				}
				await until(() => !runButton().disabled);
			}
			release(key);
			await settle();
			expect(
				container.querySelector('[data-testid="plugin-evals-result"]')
			).toBeNull();
			expect(container.querySelector('[role="alert"]')).toBeNull();
			expect(posts()).toHaveLength(1);
			expect(stored.has(owner(a))).toBe(status === 200);
			if (rotation !== "unmount") {
				refusals.clear();
				await click();
				await until(() => posts().length === 2);
				await settle();
				expect(posts()[1]!.owner).toBe(owner(current));
				expect(container.textContent).toContain(`${owner(current)}:owned-case`);
			}
		});
test("same-turn clicks submit one expensive eval run while the actual HTTP acknowledgement is held", async () => {
	await render(a);
	await until(() => !runButton().disabled);
	const key = hold(a, "POST");
	await act(async () => {
		const button = runButton();
		button.click();
		button.click();
	});
	await until(() => posts().length > 0);
	expect(posts()).toHaveLength(1);
	expect(runButton().disabled).toBe(true);
	release(key);
	await until(() => stored.has(owner(a)));
	await settle();
	expect(runButton().disabled).toBe(false);
});
test("suite403 offers an actual Retry and refuses all runs until the authenticated GET succeeds", async () => {
	refusals.set(`${owner(a)}:GET`, 403);
	await render(a);
	await until(() => container.querySelector('[role="alert"]') !== null);
	expect(runButton().disabled).toBe(true);
	await click();
	expect(posts()).toEqual([]);
	const retry = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent?.trim() === "Retry");
	expect(retry).toBeDefined();
	refusals.clear();
	await click(retry!);
	await until(() => !runButton().disabled);
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
	await click();
	await until(() => stored.has(owner(a)));
	await settle();
	expect(container.textContent).toContain(`${owner(a)}:owned-case`);
});

for (const rotation of ["url", "token", "jwt", "aba"])
	for (const status of [200, 503])
		test(`retired ${rotation} run${status} cannot unlock or replace a newer genuinely held run`, async () => {
			await render(a);
			await until(() => !runButton().disabled);
			const old = hold(a, "POST");
			const retiredGate = held.get(old);
			await click();
			await until(() => posts().length === 1);
			if (status === 503) refusals.set(`${owner(a)}:POST`, 503);
			let current = next(rotation);
			await render(current);
			if (rotation === "aba") {
				current = a;
				await render(a);
			}
			await until(() => !runButton().disabled);
			const fresh = hold(current, "POST");
			await click();
			await until(() => posts().length === 2);
			expect(runButton().disabled).toBe(true);
			// For ABA both requests share the URL/credentials but the old physical request
			// captured its own gate before this fresh one was registered.
			if (rotation === "aba") {
				const gate = held.get(fresh)!;
				held.delete(fresh);
				const oldGate = retiredGate!;
				oldGate.release();
				held.set(fresh, gate);
			} else release(old);
			await settle();
			expect(runButton().disabled).toBe(true);
			expect(container.querySelector('[role="alert"]')).toBeNull();
			expect(
				container.querySelector('[data-testid="plugin-evals-result"]')
			).toBeNull();
			refusals.clear();
			release(fresh);
			await until(() => !runButton().disabled);
			await settle();
			expect(container.textContent).toContain(`${owner(current)}:owned-case`);
			expect(posts()).toHaveLength(2);
		});

for (const status of [200, 503])
	test(`switching installed artifact retires a held old-plugin run${status}`, async () => {
		await render(a);
		await until(() => !runButton().disabled);
		const old = hold(a, "POST");
		await click();
		await until(() => posts().length === 1);
		if (status === 503) refusals.set(`${owner(a)}:POST`, 503);
		await render(a, otherAppId);
		await until(
			() => calls.some((call) => call.method === "GET") && !runButton().disabled
		);
		release(old);
		await settle();
		expect(
			container.querySelector('[data-testid="plugin-evals-result"]')
		).toBeNull();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		refusals.clear();
		await click();
		await until(() => posts().length === 2);
		await settle();
		expect(posts().map((call) => call.body)).toEqual([
			{ id: appId },
			{ id: otherAppId },
		]);
		expect(container.textContent).toContain(`${owner(a)}:other-plugin-case`);
		expect(stored.get(owner(a))?.at(-1)?.pluginId).toBe(otherAppId);
	});
