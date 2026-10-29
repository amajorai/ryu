import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { OAuthAccountPoolPolicy } from "@/src/lib/api/pi-config.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let target: ApiTarget;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { OAuthAccountPoolControls } = await import(
	"./OAuthAccountPoolControls.tsx"
);
const { subscriptionQueryKeys } = await import("@/src/lib/api/usage.ts");
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
const client = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const first: ApiTarget = {
	url: "https://one.fixture",
	token: "one-token",
	userJwt: "one-user",
};
interface Call {
	authorization: string | null;
	body: OAuthAccountPoolPolicy | null;
	identity: string | null;
	method: string;
	url: string;
}
let calls: Call[];
let respond: (call: Call) => Response | Promise<Response>;
function policy(priority: number): OAuthAccountPoolPolicy {
	return {
		strategy: "fill_first",
		drainThresholdPercent: 80,
		accounts: {
			work: { enabled: true, priority, drainThresholdPercent: null },
			other: { enabled: false, priority: 8, drainThresholdPercent: 0 },
		},
	};
}
function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	target = { ...first };
	calls = [];
	client.clear();
	respond = (call) =>
		Response.json(call.method === "PUT" ? call.body : policy(3));
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const call: Call = {
				url: String(input),
				method: init?.method ?? "GET",
				authorization: headers.get("authorization"),
				identity: headers.get("x-ryu-user-jwt"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return await respond(call);
		},
		{ preconnect: originalFetch.preconnect }
	);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	client.clear();
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});
function view() {
	return (
		<QueryClientProvider client={client}>
			<OAuthAccountPoolControls
				accounts={[
					{
						accountId: "work",
						label: "Work",
						kind: "oauth",
						active: true,
						gatewayActive: false,
						updatedAt: 0,
					},
				]}
				capabilities={{
					credentialKinds: ["oauth"],
					quotaObservations: true,
					strategies: ["fill_first", "manual"],
				}}
				providerId="claude-pro-max"
			/>
		</QueryClientProvider>
	);
}
async function settle() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(view()));
	await settle();
	return root;
}
async function switchTarget(root: Root, next: ApiTarget) {
	target = next;
	await act(async () => root.render(view()));
	await settle();
}
function priority() {
	const input = document.querySelector<HTMLInputElement>(
		"#oauth-priority-work"
	);
	if (!input) {
		throw new Error("Missing account priority");
	}
	return input;
}
async function edit(value: number) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(priority(), String(value));
		priority().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function saveButton() {
	const button = [...document.querySelectorAll("button")].find((button) =>
		/^(Save routing|Saving…)$/.test(button.textContent?.trim() ?? "")
	);
	if (!button) {
		throw new Error("Missing save routing");
	}
	return button;
}
async function save() {
	await act(async () => {
		saveButton().click();
	});
	await settle();
}
for (const [name, second] of [
	["URL", { ...first, url: "https://two.fixture" }],
	["token", { ...first, token: "two-token" }],
	["delegation", { ...first, userJwt: "two-user" }],
] as const) {
	test(`${name} rotation loads its own policy and discards the previous authority's edits`, async () => {
		let current = policy(3);
		respond = (call) => {
			if (call.method === "PUT") {
				current = call.body!;
			}
			return Response.json(current);
		};
		const root = await mount();
		await edit(19);
		current = policy(6);
		await switchTarget(root, second);
		expect(priority().value).toBe("6");
		expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
		await edit(7);
		await save();
		expect(calls.find((call) => call.method === "PUT")).toEqual({
			url: `${second.url}/api/pi-config/providers/claude-pro-max/account-pool`,
			method: "PUT",
			authorization: `Bearer ${second.token}`,
			identity: second.userJwt ?? null,
			body: policy(7),
		});
		await act(async () => root.unmount());
		roots.splice(roots.indexOf(root), 1);
		await mount();
		expect(priority().value).toBe("7");
	});
}
test("equivalent target objects preserve dirty edits without a new read", async () => {
	const root = await mount();
	await edit(19);
	await switchTarget(root, { ...first });
	expect(priority().value).toBe("19");
	expect(calls).toHaveLength(1);
});
test("late old-authority saves cannot replace the new node's policy or unlock its pending save", async () => {
	const old = deferred();
	const fresh = deferred();
	const second = {
		...first,
		url: "https://two.fixture",
		token: "two-token",
		userJwt: "two-user",
	};
	respond = (call) =>
		call.method === "PUT"
			? call.url.startsWith(first.url)
				? old.promise
				: fresh.promise
			: Response.json(policy(call.url.startsWith(first.url) ? 3 : 6));
	const root = await mount();
	await edit(19);
	await save();
	await switchTarget(root, second);
	expect(priority().value).toBe("6");
	await edit(7);
	await save();
	await act(async () => old.resolve(Response.json(policy(19))));
	await settle();
	expect(priority().value).toBe("7");
	expect(saveButton().disabled).toBe(true);
	await act(async () => fresh.resolve(Response.json(policy(7))));
	await settle();
	expect(priority().value).toBe("7");
	expect(saveButton().disabled).toBe(true);
	expect(
		calls
			.filter((call) => call.method === "PUT")
			.map((call) => [call.url, call.authorization, call.identity, call.body])
	).toEqual([
		[
			`${first.url}/api/pi-config/providers/claude-pro-max/account-pool`,
			"Bearer one-token",
			"one-user",
			policy(19),
		],
		[
			`${second.url}/api/pi-config/providers/claude-pro-max/account-pool`,
			"Bearer two-token",
			"two-user",
			policy(7),
		],
	]);
});
test("old read completion cannot reveal a former node's policy", async () => {
	const old = deferred();
	respond = (call) =>
		call.url.startsWith(first.url) ? old.promise : Response.json(policy(6));
	const root = await mount();
	expect(document.body.textContent).toContain("Loading account routing");
	await switchTarget(root, { ...first, url: "https://two.fixture" });
	expect(priority().value).toBe("6");
	await act(async () => old.resolve(Response.json(policy(3))));
	await settle();
	expect(priority().value).toBe("6");
});
test("refused saves retain edits and unlock retry; pending writes prevent duplicate requests", async () => {
	const pending = deferred();
	let stored = policy(3);
	let reject = true;
	respond = (call) => {
		if (call.method === "GET") {
			return Response.json(stored);
		}
		if (reject) {
			return pending.promise;
		}
		stored = call.body!;
		return Response.json(stored);
	};
	const root = await mount();
	await edit(11);
	await act(async () => {
		saveButton().click();
		saveButton().click();
	});
	await settle();
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
	await act(async () =>
		pending.resolve(Response.json({ error: "Policy refused" }, { status: 403 }))
	);
	await settle();
	expect(priority().value).toBe("11");
	expect(saveButton().disabled).toBe(false);
	expect(stored).toEqual(policy(3));
	reject = false;
	await save();
	expect(stored).toEqual(policy(11));
	expect(saveButton().disabled).toBe(true);
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	await mount();
	expect(priority().value).toBe("11");
});
test("a successful load never commits the load-failure alert", async () => {
	const alerts: string[] = [];
	// React may reuse the loading paragraph and only add `role`, so watch both
	// inserted nodes and attribute changes.
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			const nodes =
				record.type === "attributes" ? [record.target] : record.addedNodes;
			for (const node of nodes) {
				if (node instanceof Element && node.matches('[role="alert"]')) {
					alerts.push(node.textContent ?? "");
				}
			}
		}
	});
	observer.observe(document.body, {
		attributeFilter: ["role"],
		childList: true,
		subtree: true,
	});
	await mount();
	expect(priority().value).toBe("3");
	observer.disconnect();
	expect(alerts).toEqual([]);
});
test("refreshing quota and saving routing invalidate the snapshot-backed usage views", async () => {
	respond = (call) => {
		if (call.url.includes("/api/usage/subscriptions")) {
			return Response.json({
				version: 1,
				generatedAt: "2026-10-16T00:00:00Z",
				providers: [],
			});
		}
		return Response.json(call.method === "PUT" ? call.body : policy(3));
	};
	const snapshotKey = [
		...subscriptionQueryKeys.snapshot(first, undefined),
		"refresh",
	];
	const activeKey = subscriptionQueryKeys.reading(
		first,
		"claude-pro-max",
		null
	);
	const seed = () => {
		client.setQueryData(snapshotKey, { stale: true });
		client.setQueryData(activeKey, { stale: true });
	};
	seed();
	await mount();
	const refresh = [...document.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === "Refresh quota"
	);
	await act(async () => {
		refresh?.click();
	});
	await settle();
	expect(calls.some((call) => call.url.includes("usage=force"))).toBe(true);
	expect(client.getQueryState(snapshotKey)?.isInvalidated).toBe(true);
	expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);

	seed();
	await edit(9);
	await save();
	expect(client.getQueryState(snapshotKey)?.isInvalidated).toBe(true);
	expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
});
