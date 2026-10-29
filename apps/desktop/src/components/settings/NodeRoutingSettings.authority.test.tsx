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
import type { Root } from "react-dom/client";
import { sileo } from "sileo";
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
interface Target {
	url: string;
	token: string | null;
	userJwt?: string | null;
}
interface Policy {
	fallback: string[];
	openrouter?: Record<string, unknown>;
	openrouter_model_fallbacks?: string[];
	firewall?: {
		custom_patterns: Array<{ kind: string; name: string; regex: string }>;
	};
}
interface Call {
	lane: string;
	method: string;
	authorization: string | null;
	jwt: string | null;
	value: string | null;
	status: number;
}
let active: Target;
let stored: Record<string, Policy>;
let readStatus: number;
let writeStatus: number;
let heldRead = false;
let heldWrite = false;
let release: (() => void) | undefined;
let business = true;
const calls: Call[] = [];
const unexpected: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		const path = new URL(request.url).pathname;
		const matched = /^\/(A|B)\/api\/preferences\/node-routing-prefs$/.exec(
			path
		);
		if (!matched || !["GET", "PUT"].includes(request.method)) {
			unexpected.push(`${request.method} ${path}`);
			return NativeResponse.json(
				{ error: "Unexpected request" },
				{ status: 503 }
			);
		}
		const lane = matched[1]!;
		const raw =
			request.method === "PUT"
				? ((await request.json()) as { value: string })
				: null;
		const call: Call = {
			lane,
			method: request.method,
			authorization: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
			value: raw?.value ?? null,
			status: 0,
		};
		calls.push(call);
		if (
			`${server.url.origin}/${lane}` !== active.url ||
			call.authorization !== `Bearer ${active.token}` ||
			call.jwt !== (active.userJwt ?? null)
		) {
			unexpected.push(`Wrong authority ${request.method} ${path}`);
			call.status = 403;
			return NativeResponse.json({ error: "Wrong authority" }, { status: 403 });
		}
		const snapshot = structuredClone(stored[lane]);
		if (
			(request.method === "GET" && heldRead && lane === "A") ||
			(request.method === "PUT" && heldWrite && lane === "A")
		)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		const status = request.method === "GET" ? readStatus : writeStatus;
		call.status = status;
		if (status !== 200 && status !== 404)
			return NativeResponse.json(
				{ error: "Routing policy refused" },
				{ status }
			);
		if (status === 404)
			return NativeResponse.json({ error: "Unset preference" }, { status });
		if (raw) stored[lane] = JSON.parse(raw.value);
		return NativeResponse.json({
			key: "node-routing-prefs",
			value: JSON.stringify(raw ? stored[lane] : snapshot),
		});
	},
});
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: { getState: () => ({ getActiveNode: () => active }) },
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => active,
}));
mock.module("@/src/hooks/useOrgBillingStatus.ts", () => ({
	useOrgBillingStatus: () => ({
		activeOrgId: "org-a",
		loading: false,
		plan: business ? "business" : "pro",
		billing: { scope: "org", organizationId: "org-a" },
	}),
}));
mock.module("@/src/lib/api/orgs.ts", () => ({ hasOrgAuth: () => true }));
mock.module("@/src/lib/api/openrouter.ts", () => ({
	fetchOpenRouterProviders: async () => [{ slug: "alpha", name: "Alpha" }],
}));
const { NodeRoutingSettings } = await import("./NodeRoutingSettings.tsx");
let root: Root | undefined;
let container: HTMLDivElement;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
const target = (
	lane: string,
	token = `${lane}-token`,
	jwt = `${lane}-jwt`
): Target => ({ url: `${server.url.origin}/${lane}`, token, userJwt: jwt });
const policy = (lane: string): Policy => ({
	fallback: [`provider-${lane.toLowerCase()}`],
	openrouter: {
		only: [`vendor-${lane.toLowerCase()}`],
		data_collection: "deny",
		allow_fallbacks: false,
	},
	openrouter_model_fallbacks: [`model-${lane.toLowerCase()}`],
	firewall: {
		custom_patterns: [
			{ kind: "pii", name: `private-${lane}`, regex: "secret[0-9]+" },
		],
	},
});
beforeEach(() => {
	stored = { A: policy("A"), B: policy("B") };
	active = target("A");
	readStatus = writeStatus = 200;
	heldRead = heldWrite = false;
	release = undefined;
	business = true;
	calls.length = unexpected.length = 0;
	container = document.createElement("div");
	document.body.append(container);
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
});
afterEach(async () => {
	heldRead = heldWrite = false;
	release?.();
	await act(async () => root?.unmount());
	root = undefined;
	container.remove();
	errorToast.mockRestore();
	successToast.mockRestore();
	expect(unexpected).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	mock.restore();
	globalThis.fetch = nativeFetch;
});
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 150; attempt++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		if (predicate()) return;
	}
	throw new Error(
		`Actual mounted routing did not settle: ${container.textContent}`
	);
}
async function render() {
	root ??= createRoot(container);
	await act(async () => root!.render(<NodeRoutingSettings />));
}
const input = () =>
	container.querySelector<HTMLInputElement>(
		'input[placeholder="anthropic, openrouter, local"]'
	)!;
function button(name: string) {
	const found = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((x) => x.textContent?.trim() === name);
	if (!found) throw new Error(`Missing ${name}`);
	return found;
}
const writes = () => calls.filter((x) => x.method === "PUT");
async function edit(value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)!.set!.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
for (const status of [500, 403])
	test(`refused ${status} policy reads never enable a destructive Save; Retry loads persisted policy`, async () => {
		readStatus = status;
		await render();
		await until(() => calls.some((x) => x.status === status));
		expect(button("Save routing preferences").disabled).toBe(true);
		expect(writes()).toEqual([]);
		expect(stored.A).toEqual(policy("A"));
		expect(container.textContent).toContain(
			"Could not load routing preferences"
		);
		readStatus = 200;
		await act(async () => button("Retry routing preferences").click());
		await until(() => input().value === "provider-a");
		expect(button("Save routing preferences").disabled).toBe(false);
		await edit(" changed, local ");
		await act(async () => button("Save routing preferences").click());
		await until(() => writes()[0]?.status === 200);
		expect(stored.A).toEqual({
			...policy("A"),
			fallback: ["changed", "local"],
		});
		expect(writes()[0]).toMatchObject({
			authorization: "Bearer A-token",
			jwt: "A-jwt",
		});
		await act(async () => root!.unmount());
		root = undefined;
		await render();
		await until(() => input()?.value === "changed, local");
		expect(writes()).toHaveLength(1);
		expect(
			calls
				.filter((x) => x.method === "GET")
				.every((x) => x.authorization === "Bearer A-token" && x.jwt === "A-jwt")
		).toBe(true);
	});
test("404 is intentionally unset and can create a first policy", async () => {
	delete stored.A;
	readStatus = 404;
	await render();
	await until(() => input() && !button("Save routing preferences").disabled);
	expect(input().value).toBe("");
	readStatus = 200;
	await edit(" local ");
	await act(async () => button("Save routing preferences").click());
	await until(() => writes()[0]?.status === 200);
	expect(stored.A?.fallback).toEqual(["local"]);
});
test("late A policy reads cannot replace the newly selected B policy", async () => {
	heldRead = true;
	await render();
	await until(() => release !== undefined);
	active = target("B");
	await render();
	await until(() => input()?.value === "provider-b");
	await act(async () => {
		heldRead = false;
		release!();
	});
	await until(() => calls.every((x) => x.status !== 0));
	expect(input().value).toBe("provider-b");
	await edit("b-draft");
	await act(async () => button("Save routing preferences").click());
	await until(() => writes()[0]?.status === 200);
	expect(writes()[0]).toMatchObject({
		lane: "B",
		authorization: "Bearer B-token",
		jwt: "B-jwt",
	});
	expect(stored.A).toEqual(policy("A"));
	expect(stored.B).toEqual({ ...policy("B"), fallback: ["b-draft"] });
});
for (const scope of ["url", "token", "jwt"] as const)
	test(`${scope} authority rotation loads a fresh policy and isolates a held refused old save`, async () => {
		await render();
		await until(() => input()?.value === "provider-a");
		await edit("old-draft");
		heldWrite = true;
		writeStatus = 500;
		await act(async () => button("Save routing preferences").click());
		await until(() => release !== undefined);
		active =
			scope === "url"
				? target("B")
				: scope === "token"
					? target("A", "A-rotated", "A-jwt")
					: target("A", "A-token", "A-rotated-jwt");
		if (scope !== "url") stored.A = policy("B");
		await render();
		await until(() => input()?.value === "provider-b");
		expect(button("Save routing preferences").disabled).toBe(false);
		const priorErrors = errorToast.mock.calls.length;
		await act(async () => {
			heldWrite = false;
			release!();
		});
		await until(() => writes()[0]?.status === 500);
		expect(errorToast.mock.calls.length).toBe(priorErrors);
		expect(input().value).toBe("provider-b");
		writeStatus = 200;
		await edit("new-draft");
		await act(async () => button("Save routing preferences").click());
		await until(() => writes()[1]?.status === 200);
		expect(writes()[1]).toMatchObject({
			lane: scope === "url" ? "B" : "A",
			authorization: `Bearer ${active.token}`,
			jwt: active.userJwt,
		});
		expect(stored[scope === "url" ? "B" : "A"]).toEqual({
			...policy("B"),
			fallback: ["new-draft"],
		});
	});
test("equivalent target preserves dirty edits and same-turn Save issues one exact PUT", async () => {
	await render();
	await until(() => input()?.value === "provider-a");
	await edit(" dirty-a ");
	const readCount = calls.length;
	active = { ...active };
	await render();
	expect(input().value).toBe(" dirty-a ");
	expect(calls.length).toBe(readCount);
	heldWrite = true;
	await act(async () => {
		button("Save routing preferences").click();
		button("Save routing preferences").click();
	});
	await until(() => writes().length >= 1 && release !== undefined);
	expect(writes()).toHaveLength(1);
	await act(async () => {
		heldWrite = false;
		release!();
	});
	await until(() => writes()[0]?.status === 200);
	expect(stored.A).toEqual({ ...policy("A"), fallback: ["dirty-a"] });
});

test("late successful A save updates A storage without completing or overwriting B controls", async () => {
	await render();
	await until(() => input()?.value === "provider-a");
	await edit("accepted-a");
	heldWrite = true;
	await act(async () => button("Save routing preferences").click());
	await until(() => release !== undefined);
	active = target("B");
	await render();
	await until(() => input()?.value === "provider-b");
	await edit("unsaved-b");
	await act(async () => {
		heldWrite = false;
		release!();
	});
	await until(() => writes()[0]?.status === 200);
	expect(stored.A).toEqual({ ...policy("A"), fallback: ["accepted-a"] });
	expect(stored.B).toEqual(policy("B"));
	expect(input().value).toBe("unsaved-b");
	expect(successToast.mock.calls).toHaveLength(0);
	expect(button("Save routing preferences").disabled).toBe(false);
});
test("refused current save retains the exact draft, unlocks retry and reloads accepted policy", async () => {
	await render();
	await until(() => input()?.value === "provider-a");
	await edit("retry-draft");
	writeStatus = 500;
	await act(async () => button("Save routing preferences").click());
	await until(
		() =>
			errorToast.mock.calls.length === 1 &&
			!button("Save routing preferences").disabled
	);
	expect(stored.A).toEqual(policy("A"));
	expect(input().value).toBe("retry-draft");
	writeStatus = 200;
	await act(async () => button("Save routing preferences").click());
	await until(() => writes()[1]?.status === 200);
	expect(writes().map((x) => JSON.parse(x.value!))).toEqual([
		{ ...policy("A"), fallback: ["retry-draft"] },
		{ ...policy("A"), fallback: ["retry-draft"] },
	]);
	await act(async () => root!.unmount());
	root = undefined;
	await render();
	await until(() => input()?.value === "retry-draft");
	expect(stored.A).toEqual({ ...policy("A"), fallback: ["retry-draft"] });
});
test("nonBusiness gate preserves hidden stored provider policy when changing basic fallback", async () => {
	business = false;
	await render();
	await until(() => input()?.value === "provider-a");
	expect(container.textContent).toContain("Business plan required");
	expect(
		container.querySelector(
			'[aria-label="Advanced OpenRouter provider options JSON"]'
		)
	).toBeNull();
	await edit("basic-only");
	await act(async () => button("Save routing preferences").click());
	await until(() => writes()[0]?.status === 200);
	expect(stored.A).toEqual({ ...policy("A"), fallback: ["basic-only"] });
});
