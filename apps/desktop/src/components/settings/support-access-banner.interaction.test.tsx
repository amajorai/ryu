import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Toaster, toast } from "@ryu/ui/components/sileo";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
const NativeResponse = globalThis.Response,
	nativeFetch = globalThis.fetch,
	nativeInterval = globalThis.setInterval;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node: ApiTarget;
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: (
		selector: (state: { getActiveNode: () => ApiTarget }) => ApiTarget
	) => selector({ getActiveNode: () => node }),
}));
const { createRoot } = await import("react-dom/client");
const { SupportAccessBanner } = await import("./support-access-banner.tsx");
interface Grant {
	enabled: boolean;
	expiry: number | string | null;
}
interface Call {
	key: string;
	method: string;
	token: string | null;
	jwt: string | null;
	body: unknown;
}
let grants: Record<string, Grant>,
	calls: Call[],
	deferredReads: Set<string>,
	deferredWrites: Set<string>,
	releases: Record<string, Array<() => void>>,
	refuse: boolean,
	ignoreWrites: boolean,
	pendingFetches: number;
let server: ReturnType<typeof Bun.serve>, root: Root, container: HTMLDivElement;
let errorToast: ReturnType<typeof spyOn<typeof toast, "error">>,
	intervalSpy: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>,
	poll: (() => void) | undefined;
beforeEach(() => {
	grants = { a: { enabled: true, expiry: 0 }, b: { enabled: true, expiry: 0 } };
	calls = [];
	deferredReads = new Set();
	deferredWrites = new Set();
	releases = {};
	refuse = ignoreWrites = false;
	pendingFetches = 0;
	poll = undefined;
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof nativeFetch>) => {
			pendingFetches++;
			try {
				return await nativeFetch(...args);
			} finally {
				pendingFetches--;
			}
		},
		nativeFetch
	);
	errorToast = spyOn(toast, "error");
	intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
		((...args: Parameters<typeof nativeInterval>) => {
			const [handler, timeout] = args;
			if (timeout === 15000 && typeof handler === "function")
				poll = handler as () => void;
			return nativeInterval(...args);
		}) as typeof nativeInterval
	);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const key = decodeURIComponent(
				new URL(request.url).pathname.split("/").at(-1)!
			);
			const jwt = request.headers.get("x-ryu-user-jwt"),
				identity = jwt ?? "a",
				grant = grants[identity];
			if (!grant)
				return NativeResponse.json(
					{ error: "Unknown identity" },
					{ status: 401 }
				);
			const body = request.method === "PUT" ? await request.json() : null;
			calls.push({
				key,
				method: request.method,
				token: request.headers.get("authorization"),
				jwt,
				body,
			});
			const snapshot =
				key === "support-access-local-enabled"
					? String(grant.enabled)
					: grant.expiry === null
						? null
						: String(grant.expiry);
			if (
				(request.method === "GET" ? deferredReads : deferredWrites).has(
					identity
				)
			)
				await new Promise<void>((resolve) =>
					(releases[identity] ??= []).push(resolve)
				);
			if (request.method === "PUT") {
				if (refuse)
					return NativeResponse.json(
						{ error: "Grant revocation refused" },
						{ status: 403 }
					);
				if (!ignoreWrites)
					grant.enabled = (body as { value: string }).value === "true";
				return NativeResponse.json({ key, value: String(grant.enabled) });
			}
			return NativeResponse.json({ key, value: snapshot });
		},
	});
	node = {
		url: server.url.toString().replace(/\/$/, ""),
		token: "selected-core",
		userJwt: "a",
	};
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	deferredReads.clear();
	deferredWrites.clear();
	for (const group of Object.values(releases))
		for (const release of group) release();
	await idle();
	await act(async () => {
		for (const result of errorToast.mock.results) {
			if (result.type === "return" && typeof result.value === "string") {
				toast.dismiss(result.value);
			}
		}
		await Bun.sleep(650);
	});
	server.stop(true);
	container.remove();
	errorToast.mockRestore();
	intervalSpy.mockRestore();
	globalThis.fetch = nativeFetch;
});
async function until(check: () => boolean) {
	for (let i = 0; i < 150; i++) {
		await act(async () => {
			await Bun.sleep(10);
		});
		if (check()) return;
	}
	throw Error("Expected mounted state or actual HTTP request did not settle");
}
async function render() {
	await act(async () =>
		root.render(
			<>
				<SupportAccessBanner />
				<Toaster />
			</>
		)
	);
}
async function idle() {
	await until(() => pendingFetches === 0);
	await act(async () => {
		await Bun.sleep(10);
	});
}
function button() {
	const result = container.querySelector<HTMLButtonElement>("button");
	if (!result) throw Error("Active grant has no End now action");
	return result;
}
function active() {
	return container.textContent?.includes("Support access active") ?? false;
}
function writes() {
	return calls.filter((c) => c.method === "PUT");
}
async function end() {
	await act(async () => button().click());
}
async function release(identity: string) {
	deferredReads.delete(identity);
	deferredWrites.delete(identity);
	await act(async () => {
		for (const resume of releases[identity] ?? []) resume();
	});
	await idle();
}
for (const [name, enabled, expiry, visible] of [
	["unlimited active", true, 0, true],
	["disabled", false, 0, false],
	["expired", true, 1, false],
] as const)
	test(`renders authoritative ${name} grant state`, async () => {
		grants.a = { enabled, expiry };
		await render();
		await until(() => calls.length === 2);
		await idle();
		expect(active()).toBe(visible);
		expect(
			calls.map((c) => ({ key: c.key, token: c.token, jwt: c.jwt }))
		).toEqual([
			{
				key: "support-access-local-enabled",
				token: "Bearer selected-core",
				jwt: "a",
			},
			{
				key: "support-access-local-expiry",
				token: "Bearer selected-core",
				jwt: "a",
			},
		]);
	});
// Core privacy::support_access_local trims and parses i64, then defaults to
// zero on parse failure. Exercise the actual HTTP preference reader and banner
// together: a looser Number parser can hide an active grant or invent an expiry.
for (const raw of [
	"1e3",
	"0x1000",
	"0b1000",
	"1.5",
	" \t\n ",
	"\uFEFF1",
	"9223372036854775808",
	"-9223372036854775809",
])
	test(`malformed expiry ${JSON.stringify(raw)} retains a revocable grant with no expiry`, async () => {
		grants.a.expiry = raw;
		await render();
		await until(() => calls.length === 2);
		await idle();
		expect(active()).toBe(true);
		expect(container.textContent).toContain("no expiry set");
		await end();
		await until(() => !active());
		expect(grants.a.enabled).toBe(false);
		expect(writes().map((call) => call.body)).toEqual([{ value: "false" }]);
	});
for (const raw of [null, "0", "+0", "-0"])
	test(`missing or signed zero expiry ${JSON.stringify(raw)} has no expiry`, async () => {
		grants.a.expiry = raw;
		await render();
		await until(() => calls.length === 2);
		await idle();
		expect(active()).toBe(true);
		expect(container.textContent).toContain("no expiry set");
	});
for (const raw of ["-1", "-9223372036854775808", "0001"])
	test(`valid expired signed decimal ${raw} hides the expired grant`, async () => {
		grants.a.expiry = raw;
		await render();
		await until(() => calls.length === 2);
		await idle();
		expect(active()).toBe(false);
		expect(writes()).toHaveLength(0);
	});
test("trimmed leading-plus decimal future expiry shows remaining time until Core expiry", async () => {
	grants.a.expiry = ` \t\u00a0+${Date.now() + 90_000}\u0085\n`;
	await render();
	await until(active);
	expect(container.textContent).toContain("expires in 1 min");
	grants.a.expiry = "1";
	await act(async () => poll!());
	await until(() => !active());
	expect(writes()).toHaveLength(0);
});
test("maximum signed-i64 expiry remains a valid timed grant", async () => {
	grants.a.expiry = "9223372036854775807";
	await render();
	await until(active);
	expect(container.textContent).toContain("expires in ");
	expect(container.textContent).not.toContain("no expiry set");
});
test("JWT rotation at the same URL and bearer reloads the newly selected authority", async () => {
	grants.b.enabled = false;
	await render();
	await until(active);
	node = { ...node, userJwt: "b" };
	await render();
	await until(() => calls.filter((c) => c.jwt === "b").length === 2);
	await idle();
	expect(active()).toBe(false);
	expect(
		calls
			.filter((c) => c.jwt === "b")
			.every((c) => c.token === "Bearer selected-core")
	).toBe(true);
});
test("late prior-node reads cannot erase the newly selected active grant", async () => {
	grants.a.enabled = false;
	deferredReads.add("a");
	await render();
	await until(() => calls.length === 2);
	node = { ...node, token: "other-core", userJwt: "b" };
	await render();
	await until(active);
	await release("a");
	expect(active()).toBe(true);
	expect(button().disabled).toBe(false);
	expect(
		calls
			.filter((c) => c.jwt === "b")
			.every((c) => c.token === "Bearer other-core")
	).toBe(true);
});
test("old-node End now completion cannot dismiss the new grant or unlock its pending revocation", async () => {
	await render();
	await until(active);
	deferredWrites.add("a");
	await end();
	await until(() => writes().length === 1);
	node = { ...node, token: "other-core", userJwt: "b" };
	await render();
	await until(() => active() && !button().disabled);
	deferredWrites.add("b");
	await end();
	await until(() => writes().length === 2);
	deferredWrites.delete("a");
	await act(async () => {
		for (const resume of releases.a ?? []) resume();
		await Bun.sleep(30);
	});
	expect(grants.a.enabled).toBe(false);
	expect(active()).toBe(true);
	expect(button().disabled).toBe(true);
	await release("b");
	await until(() => !active());
	expect(grants.b.enabled).toBe(false);
	expect(writes()).toEqual([
		{
			key: "support-access-local-enabled",
			method: "PUT",
			token: "Bearer selected-core",
			jwt: "a",
			body: { value: "false" },
		},
		{
			key: "support-access-local-enabled",
			method: "PUT",
			token: "Bearer other-core",
			jwt: "b",
			body: { value: "false" },
		},
	]);
});
test("a refused revocation retains the banner and real error toast, then retry reads back saved state", async () => {
	await render();
	await until(active);
	refuse = true;
	await end();
	await until(() => errorToast.mock.calls.length === 1);
	await idle();
	expect(active()).toBe(true);
	expect(button().disabled).toBe(false);
	expect(grants.a.enabled).toBe(true);
	expect(document.body.textContent).toContain("Couldn't end support access");
	refuse = false;
	await end();
	await until(() => !active());
	expect(grants.a.enabled).toBe(false);
	expect(calls.at(-1)).toMatchObject({
		method: "GET",
		key: "support-access-local-enabled",
		jwt: "a",
	});
	await act(async () => root.unmount());
	root = createRoot(container);
	await render();
	await idle();
	expect(active()).toBe(false);
});
test("HTTP acknowledgement without persisted revocation keeps the banner retryable", async () => {
	await render();
	await until(active);
	ignoreWrites = true;
	await end();
	await idle();
	expect(active()).toBe(true);
	expect(button().disabled).toBe(false);
	expect(errorToast.mock.calls).toHaveLength(1);
	ignoreWrites = false;
	await end();
	await until(() => !active());
	expect(grants.a.enabled).toBe(false);
});
test("polling reflects out-of-band expiry and pending revocation is single-flight", async () => {
	await render();
	await until(active);
	expect(poll).toBeDefined();
	grants.a.expiry = Date.now() - 1;
	await act(async () => poll!());
	await until(() => !active());
	grants.a.expiry = 0;
	await act(async () => poll!());
	await until(active);
	deferredWrites.add("a");
	await act(async () => {
		button().click();
		button().click();
	});
	await until(() => writes().length >= 1);
	expect(writes()).toHaveLength(1);
	expect(button().disabled).toBe(true);
	await release("a");
	await until(() => !active());
});

test("a stale polling snapshot cannot re-enable the banner after confirmed revocation", async () => {
	await render();
	await until(active);
	deferredReads.add("a");
	await act(async () => poll!());
	await until(() => releases.a?.length === 2);
	await end();
	await until(() => releases.a?.length === 3);
	await act(async () => releases.a[2]());
	await until(() => !active());
	deferredReads.delete("a");
	await act(async () => {
		releases.a[0]();
		releases.a[1]();
	});
	await idle();
	expect(active()).toBe(false);
	expect(grants.a.enabled).toBe(false);
});

test("a late refused old-node revocation cannot report an error for the newly selected node", async () => {
	await render();
	await until(active);
	deferredWrites.add("a");
	await end();
	await until(() => writes().length === 1);
	node = { ...node, token: "other-core", userJwt: "b" };
	await render();
	await until(() => active() && !button().disabled);
	refuse = true;
	await release("a");
	expect(active()).toBe(true);
	expect(button().disabled).toBe(false);
	expect(errorToast.mock.calls).toHaveLength(0);
	expect(grants.a.enabled).toBe(true);
	refuse = false;
	await end();
	await until(() => !active());
	expect(grants.b.enabled).toBe(false);
});

test("a timed active grant renders the remaining hours and minutes", async () => {
	grants.a.expiry = Date.now() + 90 * 60000 + 5000;
	await render();
	await until(active);
	expect(container.textContent).toContain("expires in 1 h 30 min");
});

test("a newly selected node never inherits the previous node's banner while its grant is loading", async () => {
	await render();
	await until(active);
	grants.b.enabled = false;
	deferredReads.add("b");
	node = { ...node, token: "other-core", userJwt: "b" };
	await render();
	await until(() => calls.filter((c) => c.jwt === "b").length === 2);
	expect(active()).toBe(false);
	expect(writes()).toHaveLength(0);
	await release("b");
	expect(active()).toBe(false);
});
