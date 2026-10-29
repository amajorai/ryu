import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { sileo } from "sileo";
import { z } from "zod";
import type { Node } from "@/src/store/useNodeStore.ts";

// Save native HTTP primitives before installing the DOM. No API/hook aliases.
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Observe/restrict transport without replacing any response or client. Even
// transitive host imports may only reach this process-owned HTTP fixture.
let ownedOrigin: string | null = null;
const rejectedEgress: string[] = [];
let pendingNativeFetches = 0;
let pendingNativeBodies = 0;
interface ConsumedRead {
	authorization: string | null;
	key: string;
	status: number;
	url: string;
	userJwt: string | null;
}
let consumedReads: ConsumedRead[] = [];
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const observedRequest = new NativeRequest(input, init);
		const url = new URL(observedRequest.url);
		if (url.origin !== ownedOrigin) {
			rejectedEgress.push(url.href);
			console.error("PRIVATE_REJECTED_EGRESS", url.href);
			throw new Error("Private settings baseline refuses unowned HTTP egress");
		}
		pendingNativeFetches++;
		try {
			const response = await nativeFetch(input, init);
			const method = observedRequest.method;
			const key = /\/api\/preferences\/(.+)$/.exec(url.pathname)?.[1];
			if (method === "GET" && key) {
				const headers = observedRequest.headers;
				let recorded = false;
				const consumed = () => {
					if (!recorded) {
						recorded = true;
						consumedReads.push({
							url: url.href,
							authorization: headers.get("authorization"),
							userJwt: headers.get("x-ryu-user-jwt"),
							key,
							status: response.status,
						});
					}
				};
				const realText = response.text.bind(response);
				const realJson = response.json.bind(response);
				// Passive body-consumption observer: return the ORIGINAL native response,
				// delegate its ORIGINAL methods and retain exact body/status/errors.
				response.text = async () => {
					pendingNativeBodies++;
					try {
						const value = await realText();
						consumed();
						return value;
					} finally {
						pendingNativeBodies--;
					}
				};
				response.json = async () => {
					pendingNativeBodies++;
					try {
						const value = await realJson();
						consumed();
						return value;
					} finally {
						pendingNativeBodies--;
					}
				};
			}
			return response;
		} finally {
			pendingNativeFetches--;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;

// Use the actual host auth/vault module too: transitive settings modules read
// its real exports. No auth, node hook, SDK, consent gate or UI aliases.
const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo");
const { PrivacySettings } = await import("./PrivacySettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { apiUrl } = await import("@/src/lib/api/client.ts");
function physicalUrl(url: string) {
	return apiUrl({ url, token: null }, "");
}
const { isAnalyticsEnabled } = await import("@/src/lib/analytics.ts");

interface Call {
	authorization: string | null;
	body: { value: string } | null;
	key: string;
	method: string;
	url: string;
	userJwt: string | null;
}
interface Held {
	arrived: (call: Call) => void;
	consumed: boolean;
	finish: () => void;
	finished: Promise<void>;
	match: (call: Call) => boolean;
	received: Promise<Call>;
	status: number;
}
// Preferences are durable per physical node URL, not isolated by credentials.
const defaults = {
	"product-analytics-enabled": "true",
	"community-stats-enabled": "true",
	"profile-activity-enabled": "true",
	"crash-reports-enabled": "true",
	"diagnostics-export-enabled": "false",
	"diagnostics-otlp-endpoint": "",
	"diagnostics-otlp-content-mode": "metadata_only",
	"support-access-local-enabled": "false",
	"support-access-local-expiry": "0",
};
let calls: Call[] = [];
let holds: Held[] = [];
const durable = new Map<string, Map<string, string>>();
const authorized = new Set<string>();
let settled: Array<{ call: Call; status: number }> = [];
type FixtureReply = { error: string } | { ok: true };
const preferenceBodySchema = z.object({ value: z.string() });
function reply(call: Call, value: FixtureReply, status = 200) {
	settled.push({ call, status });
	return NativeResponse.json(value, { status });
}
function identity(
	url: string,
	authorization: string | null,
	jwt: string | null
) {
	return JSON.stringify([physicalUrl(url), authorization, jwt]);
}
function state(node: Node) {
	const key = physicalUrl(node.url);
	let values = durable.get(key);
	if (!values) {
		values = new Map(Object.entries(defaults));
		durable.set(key, values);
	}
	return values;
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const path =
			/^\/(first|second)\/api\/(preferences\/(.+)|healing\/config)$/.exec(
				url.pathname
			);
		if (!path) {
			return NativeResponse.json(
				{ error: "Unexpected route" },
				{ status: 500 }
			);
		}
		const base = `${url.origin}/${path[1]}`;
		const authorization = request.headers.get("authorization");
		const userJwt = request.headers.get("x-ryu-user-jwt");
		const parsedBody =
			request.method === "GET"
				? null
				: preferenceBodySchema.safeParse(await request.json());
		const record: Call = {
			url: request.url,
			method: request.method,
			authorization,
			userJwt,
			key: path[3] ?? "healing",
			body: parsedBody?.success ? parsedBody.data : null,
		};
		calls.push(record);
		if (!(authorization && userJwt)) {
			return NativeResponse.json(
				{ error: "Missing authenticated authority" },
				{ status: 401 }
			);
		}
		if (!authorized.has(identity(base, authorization, userJwt))) {
			return reply(record, { error: "Unknown authenticated authority" }, 403);
		}
		if (record.key === "healing") {
			return NativeResponse.json({
				enabled: true,
				auto_decide: false,
				cooldown_secs: 300,
				diagnose_effort: "low",
				diagnose_model: "fixture",
				max_attempts: 1,
			});
		}
		const values = durable.get(physicalUrl(base));
		if (!values) {
			return NativeResponse.json(
				{ error: "Unknown authenticated authority" },
				{ status: 403 }
			);
		}
		const snapshot = values.get(record.key) ?? null;
		if (
			request.method !== "GET" &&
			(request.method !== "PUT" || record.body === null)
		) {
			return NativeResponse.json(
				{ error: "Unexpected preference mutation" },
				{ status: 400 }
			);
		}
		const hold = holds.find((h) => !h.consumed && h.match(record));
		if (hold) {
			hold.consumed = true;
			hold.arrived(record);
			await hold.finished;
			if (hold.status !== 200) {
				return reply(record, { error: "Permission denied" }, hold.status);
			}
		}
		if (request.method === "GET") {
			return NativeResponse.json({ key: record.key, value: snapshot });
		}
		values.set(record.key, record.body!.value);
		return reply(record, { ok: true });
	},
});
ownedOrigin = server.url.origin;
console.info("PRIVATE_FIXTURE_ORIGIN", ownedOrigin);
const first: Node = {
	name: "first",
	url: `${server.url.origin}/first`,
	token: "first-token",
	userJwt: "first-user",
};
const variants: Node[] = [
	{ ...first, name: "other-url", url: `${server.url.origin}/second` },
	{ ...first, name: "other-token", token: "second-token" },
	{ ...first, name: "other-user", userJwt: "second-user" },
];
const savedNodeState = useNodeStore.getState();
let root: Root | null = null;
function select(node: Node) {
	useNodeStore.setState({
		nodes: [node],
		localNodes: [],
		defaultNode: node.name,
		autoSelect: false,
	});
}
function holdWrite(key: string, node = first, status = 200, method = "PUT") {
	let arrived!: (call: Call) => void;
	let finish!: () => void;
	const held: Held = {
		match: (c) =>
			c.method === method &&
			c.key === key &&
			c.url.startsWith(apiUrl(node, "")) &&
			c.authorization === `Bearer ${node.token}` &&
			c.userJwt === node.userJwt,
		status,
		received: new Promise((done) => {
			arrived = done;
		}),
		arrived: (c) => arrived(c),
		finished: new Promise((done) => {
			finish = done;
		}),
		finish: () => finish(),
		consumed: false,
	};
	holds.push(held);
	return held;
}
async function flush() {
	await act(async () => {
		await Bun.sleep(10);
	});
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("Mounted HTTP condition never settled");
		}
		await flush();
	}
}
async function settleSelectedRead(node: Node, marker: number) {
	await until(() => {
		const own = consumedReads
			.slice(marker)
			.filter(
				(r) =>
					r.url.startsWith(apiUrl(node, "/api/preferences/")) &&
					r.authorization === `Bearer ${node.token}` &&
					r.userJwt === node.userJwt &&
					r.status === 200
			);
		return Object.keys(defaults).every((key) => own.some((r) => r.key === key));
	});
	await flush();
}
async function mount(
	page: "Usage & crash data" | "Diagnostics & support" = "Usage & crash data",
	waitForReads = true,
	settleReadBodies = true
) {
	const mountReadMarker = consumedReads.length;
	const mountedNode = useNodeStore.getState().nodes[0];
	const priorExpiryReads = calls.filter(
		(c) => c.method === "GET" && c.key === "support-access-local-expiry"
	).length;
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<>
				<PrivacySettings />
				<Toaster />
			</>
		)
	);
	if (waitForReads) {
		await until(
			() =>
				calls.filter(
					(c) => c.method === "GET" && c.key === "support-access-local-expiry"
				).length > priorExpiryReads
		);
	}
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((b) => b.textContent?.includes(page));
	if (!button) {
		throw new Error(`Missing real privacy subpage ${page}`);
	}
	await act(async () => button.click());
	await flush();
	if (waitForReads && settleReadBodies) {
		await settleSelectedRead(mountedNode, mountReadMarker);
	}
}
const settingNames = {
	"product-analytics": "Share anonymous usage analytics",
	"support-access-local": "Grant local support access",
};
type PrivacyControlId = keyof typeof settingNames;
function control(id: PrivacyControlId) {
	const label = settingNames[id];
	if (!label) {
		throw new Error(`Unknown privacy setting ${id}`);
	}
	const row = [
		...document.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	].find(
		(item) =>
			item.querySelector('[data-slot="item-title"]')?.textContent?.trim() ===
			label
	);
	const switchControl = row?.querySelector<HTMLElement>('[role="switch"]');
	if (!switchControl) {
		throw new Error(`Missing visible switch for ${label}`);
	}
	return switchControl;
}
function checked(id: PrivacyControlId = "product-analytics") {
	return control(id).getAttribute("aria-checked") === "true";
}
async function click(id: PrivacyControlId = "product-analytics") {
	// An intended user mutation requires the visible control to finish loading.
	// Pending-control no-write assertions below remain immediate and independent.
	await until(() => control(id).getAttribute("aria-disabled") !== "true");
	const visibleControl = control(id);
	await act(async () => visibleControl.click());
	await flush();
}
async function readBack(node: Node, key: string) {
	const response = await nativeFetch(apiUrl(node, `/api/preferences/${key}`), {
		headers: {
			authorization: `Bearer ${node.token}`,
			"x-ryu-user-jwt": node.userJwt!,
		},
	});
	// biome-ignore lint/suspicious/noMisplacedAssertion: Every caller is an actual HTTP test; preserve the independent native GET status oracle alongside durable value checks.
	expect(response.status).toBe(200);
	return (await response.json()).value;
}
function writes() {
	return calls.filter((c) => c.method === "PUT");
}
function exactWrite(node: Node, key: string, value: string): Call {
	return {
		url: apiUrl(node, `/api/preferences/${key}`),
		method: "PUT",
		authorization: `Bearer ${node.token}`,
		userJwt: node.userJwt!,
		key,
		body: { value },
	};
}
beforeEach(() => {
	sileo.clear();
	calls = [];
	holds = [];
	durable.clear();
	authorized.clear();
	settled = [];
	consumedReads = [];
	for (const node of [first, ...variants]) {
		authorized.add(
			identity(node.url, `Bearer ${node.token}`, node.userJwt ?? null)
		);
	}
	localStorage.clear();
	state(first);
	for (const node of variants) {
		state(node);
	}
	select(first);
});
afterEach(async () => {
	for (const held of holds) {
		held.finish();
	}
	// Release actual held responses before unmounting; do not hide SDK rejections.
	const cleanupDeadline = Date.now() + 2000;
	while (pendingNativeFetches > 0 || pendingNativeBodies > 0) {
		if (Date.now() > cleanupDeadline) {
			throw new Error("Owned native HTTP did not settle during cleanup");
		}
		await Bun.sleep(5);
	}
	await Bun.sleep(10);
	if (root) {
		await act(async () => root!.unmount());
		root = null;
	}
	sileo.clear();
	document.body.replaceChildren();
	useNodeStore.setState(savedNodeState);
});
afterAll(() => {
	server.stop(true);
	console.info(
		"PRIVATE_REJECTED_EGRESS_SUMMARY",
		JSON.stringify(rejectedEgress)
	);
});

function ownReads(node: Node) {
	return calls.filter(
		(c) =>
			c.method === "GET" &&
			c.url === apiUrl(node, "/api/preferences/product-analytics-enabled") &&
			c.authorization === `Bearer ${node.token}` &&
			c.userJwt === node.userJwt
	);
}
for (const node of variants) {
	test(`privacy requests retain full selected authority ${node.name}`, async () => {
		// Same physical node keeps its durable consent across credential rotation.
		if (node.url !== first.url) {
			state(node).set("product-analytics-enabled", "false");
		}
		await mount();
		expect(checked()).toBe(true);
		expect(isAnalyticsEnabled()).toBe(true);
		const before = ownReads(node).length;
		const selectedReadMarker = consumedReads.length;
		await act(async () => select(node));
		await until(() => ownReads(node).length > before);
		await settleSelectedRead(node, selectedReadMarker);
		const stored = await readBack(node, "product-analytics-enabled");
		await until(() => checked() === (stored === "true"));
		expect(isAnalyticsEnabled()).toBe(stored === "true");
		expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe(stored);
		await click();
		await until(() => writes().length === 1);
		const next = stored === "true" ? "false" : "true";
		expect(writes()).toEqual([
			exactWrite(node, "product-analytics-enabled", next),
		]);
		expect(await readBack(node, "product-analytics-enabled")).toBe(next);
		if (node.url !== first.url) {
			expect(await readBack(first, "product-analytics-enabled")).toBe("true");
		}
	});
	for (const status of [200, 403]) {
		test(`held former write ${status} settles before selected same-node fresh read ${node.name}`, async () => {
			const old = holdWrite("product-analytics-enabled", first, status);
			await mount();
			await click();
			await old.received;
			const before = ownReads(node).length;
			const selectedReadMarker = consumedReads.length;
			await act(async () => select(node));
			await flush();
			if (node.url === first.url) {
				expect(ownReads(node)).toHaveLength(before);
				expect(control("product-analytics").getAttribute("aria-disabled")).toBe(
					"true"
				);
				expect(isAnalyticsEnabled()).toBe(false);
				old.finish();
				await until(() => ownReads(node).length > before);
				await settleSelectedRead(node, selectedReadMarker);
				const saved = status === 200 ? "false" : "true";
				await until(() => checked() === (saved === "true"));
				expect(await readBack(node, "product-analytics-enabled")).toBe(saved);
				expect(isAnalyticsEnabled()).toBe(saved === "true");
				await click();
				await until(() => writes().length === 2);
				expect(writes()).toEqual([
					exactWrite(first, "product-analytics-enabled", "false"),
					exactWrite(
						node,
						"product-analytics-enabled",
						saved === "true" ? "false" : "true"
					),
				]);
			} else {
				await until(() => ownReads(node).length > before);
				await settleSelectedRead(node, selectedReadMarker);
				await until(() => checked());
				await click();
				await until(() => !checked());
				old.finish();
				await flush();
				expect(checked()).toBe(false);
				expect(isAnalyticsEnabled()).toBe(false);
				expect(await readBack(node, "product-analytics-enabled")).toBe("false");
				expect(writes()).toEqual([
					exactWrite(first, "product-analytics-enabled", "false"),
					exactWrite(node, "product-analytics-enabled", "false"),
				]);
			}
		});
	}
}
for (const node of variants) {
	for (const status of [200, 403]) {
		test(`held former read ${status} cannot own selected consent ${node.name}`, async () => {
			const old = holdWrite("product-analytics-enabled", first, status, "GET");
			await mount("Usage & crash data", true, false);
			await old.received;
			// Change the authoritative server value after the first request captured its
			// snapshot. There was no issued old write, so the selected read need not wait.
			state(node).set("product-analytics-enabled", "false");
			const before = ownReads(node).length;
			const selectedReadMarker = consumedReads.length;
			await act(async () => select(node));
			await until(() => ownReads(node).length > before);
			await settleSelectedRead(node, selectedReadMarker);
			await until(() => !checked());
			old.finish();
			await flush();
			expect(checked()).toBe(false);
			expect(isAnalyticsEnabled()).toBe(false);
			expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe(
				"false"
			);
			expect(writes()).toEqual([]);
			expect(await readBack(node, "product-analytics-enabled")).toBe("false");
		});
	}
}
for (const remount of [false, true]) {
	for (const status of [200, 403]) {
		test(`${remount ? "remounted" : "ABA"} authority waits for physical-node ${status} ACK before fresh GET`, async () => {
			const old = holdWrite("product-analytics-enabled", first, status);
			await mount();
			await click();
			await old.received;
			if (remount) {
				await act(async () => root!.unmount());
				root = null;
				calls = calls.filter((c) => c.method === "PUT");
				await mount("Usage & crash data", false);
			} else {
				await act(async () => select(variants[0]));
				await until(() => checked());
				await act(async () => select(first));
				await flush();
			}
			const priorReads = remount ? 0 : 1;
			expect(ownReads(first)).toHaveLength(priorReads);
			expect(control("product-analytics").getAttribute("aria-disabled")).toBe(
				"true"
			);
			expect(isAnalyticsEnabled()).toBe(false);
			const selectedReadMarker = consumedReads.length;
			old.finish();
			await until(() => ownReads(first).length > priorReads);
			await settleSelectedRead(first, selectedReadMarker);
			const saved = status === 200 ? "false" : "true";
			await until(() => checked() === (saved === "true"));
			expect(isAnalyticsEnabled()).toBe(saved === "true");
			expect(await readBack(first, "product-analytics-enabled")).toBe(saved);
			await click();
			await until(() => writes().length === 2);
			expect(await readBack(first, "product-analytics-enabled")).toBe(
				saved === "true" ? "false" : "true"
			);
		});
	}
}
test("second support-grant write refusal preserves acknowledged finite expiry and inactive durable grant until explicit retry", async () => {
	const refusal = holdWrite("support-access-local-enabled", first, 403);
	await mount("Diagnostics & support");
	const before = Date.now();
	await click("support-access-local");
	await refusal.received;
	const after = Date.now();
	refusal.finish();
	await until(() => !checked("support-access-local"));
	const expiry = Number(await readBack(first, "support-access-local-expiry"));
	expect(expiry).toBeGreaterThanOrEqual(before + 3_600_000);
	expect(expiry).toBeLessThanOrEqual(after + 3_600_000);
	expect(await readBack(first, "support-access-local-enabled")).toBe("false");
	expect(document.body.textContent).toContain("Couldn't grant support access");
	expect(settled).toContainEqual({
		call: exactWrite(first, "support-access-local-enabled", "true"),
		status: 403,
	});
	expect(writes()).toEqual([
		exactWrite(first, "support-access-local-expiry", String(expiry)),
		exactWrite(first, "support-access-local-enabled", "true"),
	]);
	const retryBefore = Date.now();
	await click("support-access-local");
	await until(
		() => state(first).get("support-access-local-enabled") === "true"
	);
	const retryExpiry = Number(
		await readBack(first, "support-access-local-expiry")
	);
	expect(retryExpiry).toBeGreaterThanOrEqual(retryBefore + 3_600_000);
	expect(writes()).toEqual([
		exactWrite(first, "support-access-local-expiry", String(expiry)),
		exactWrite(first, "support-access-local-enabled", "true"),
		exactWrite(first, "support-access-local-expiry", String(retryExpiry)),
		exactWrite(first, "support-access-local-enabled", "true"),
	]);
	expect(await readBack(first, "support-access-local-enabled")).toBe("true");
	await act(async () => root!.unmount());
	root = null;
	await mount("Diagnostics & support");
	expect(checked("support-access-local")).toBe(true);
});

for (const status of [200, 403]) {
	test(`same physical node URL spelling waits for old ${status} ACK then reads committed consent`, async () => {
		const spelling: Node = {
			...first,
			name: "trailing-slash",
			url: `${first.url}/`,
		};
		// Independent native GETs and all writes use the shipping URL joiner: this
		// spelling reaches the SAME endpoint and SAME durable preferences.
		const old = holdWrite("product-analytics-enabled", first, status);
		await mount();
		expect(checked()).toBe(true);
		await click();
		await old.received;
		const before = ownReads(spelling).length;
		await act(async () => select(spelling));
		await flush();
		expect(ownReads(spelling)).toHaveLength(before);
		expect(control("product-analytics").getAttribute("aria-disabled")).toBe(
			"true"
		);
		expect(isAnalyticsEnabled()).toBe(false);
		expect(writes()).toEqual([
			exactWrite(first, "product-analytics-enabled", "false"),
		]);
		const selectedReadMarker = consumedReads.length;
		old.finish();
		await until(() => ownReads(spelling).length > before);
		await settleSelectedRead(spelling, selectedReadMarker);
		const saved = status === 200 ? "false" : "true";
		await until(
			() =>
				control("product-analytics").getAttribute("aria-disabled") !== "true" &&
				checked() === (saved === "true")
		);
		expect(await readBack(spelling, "product-analytics-enabled")).toBe(saved);
		expect(await readBack(first, "product-analytics-enabled")).toBe(saved);
		expect(isAnalyticsEnabled()).toBe(saved === "true");
		expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe(saved);
		await click();
		await until(() => writes().length === 2);
		const next = saved === "true" ? "false" : "true";
		expect(writes()).toEqual([
			exactWrite(first, "product-analytics-enabled", "false"),
			exactWrite(spelling, "product-analytics-enabled", next),
		]);
		expect(await readBack(spelling, "product-analytics-enabled")).toBe(next);
		expect(await readBack(first, "product-analytics-enabled")).toBe(next);
	});
}

test("slash-only missing target shows a retryable read error without sending consent, then recovers after selecting a configured node", async () => {
	select({ ...first, name: "missing-target", url: "/" });
	await mount("Usage & crash data", false);
	await until(() => document.querySelector('[role="alert"]') !== null);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Couldn't load privacy choices"
	);
	expect(control("product-analytics").getAttribute("aria-disabled")).toBe(
		"true"
	);
	expect(isAnalyticsEnabled()).toBe(false);
	expect(calls).toEqual([]);
	const disabledConsent = control("product-analytics");
	await act(async () => disabledConsent.click());
	await flush();
	expect(writes()).toEqual([]);
	const retry = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent === "Retry privacy settings");
	if (!retry) {
		throw new Error("Missing privacy read retry");
	}
	await act(async () => retry.click());
	await flush();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Couldn't load privacy choices"
	);
	expect(calls).toEqual([]);
	expect(rejectedEgress).toEqual([]);
	const marker = consumedReads.length;
	await act(async () => select(first));
	await settleSelectedRead(first, marker);
	expect(document.querySelector('[role="alert"]') === null).toBe(true);
	expect(control("product-analytics").getAttribute("aria-disabled")).not.toBe(
		"true"
	);
	expect(checked()).toBe(true);
	expect(isAnalyticsEnabled()).toBe(true);
	await click();
	await until(() => writes().length === 1);
	expect(writes()).toEqual([
		exactWrite(first, "product-analytics-enabled", "false"),
	]);
	expect(await readBack(first, "product-analytics-enabled")).toBe("false");
});
