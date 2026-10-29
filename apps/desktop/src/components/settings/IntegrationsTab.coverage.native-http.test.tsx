import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level coverage for the shipping IntegrationsTab (Gateway →
// Integrations). Every read and write crosses real loopback HTTP to a stateful
// Core fixture: the raw preference store (`/api/preferences/:key`), the
// webhook-ingress backend route, and the gateway config the embedded Composio
// billing rows read. The fixture keeps what Core persisted so a remount is an
// independent reload.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE = { name: "integrations-node", token: "integrations-node-token" };
const AVAILABLE = ["ryu-relay", "tailscale-funnel", "cloudflared", "own-relay"];

interface CoreCall {
	body: unknown;
	method: string;
	path: string;
}
interface Refusal {
	error: string;
	status: number;
}

let preferences: Record<string, string> = {};
let ingress: { available: string[]; backend: string; default: string } | null =
	null;
/** Refuse the next request matching `${METHOD} ${path}` once. */
const refusals = new Map<string, Refusal>();
/** Hold the next request matching `${METHOD} ${path}` until released. */
const holds = new Map<string, Promise<void>>();
const releases = new Map<string, () => void>();
const calls: CoreCall[] = [];
const unexpected: string[] = [];
const rejectedEgress: string[] = [];

function hold(route: string) {
	holds.set(
		route,
		new Promise<void>((resolve) => {
			releases.set(route, resolve);
		})
	);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		const text = request.method === "GET" ? "" : await request.text();
		const body = text ? (JSON.parse(text) as unknown) : null;
		calls.push({ body, method: request.method, path: url.pathname });
		if (request.headers.get("authorization") !== `Bearer ${NODE.token}`) {
			unexpected.push(`${route} without node token`);
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const held = holds.get(route);
		if (held) {
			holds.delete(route);
			await held;
		}
		const refusal = refusals.get(route);
		if (refusal) {
			refusals.delete(route);
			return NativeResponse.json(
				{ error: refusal.error },
				{ status: refusal.status }
			);
		}
		const preference = /^\/api\/preferences\/(.+)$/u.exec(url.pathname);
		if (preference) {
			const key = decodeURIComponent(preference[1] ?? "");
			if (request.method === "GET") {
				const value = preferences[key];
				return value === undefined
					? NativeResponse.json({ error: "Unset preference" }, { status: 404 })
					: NativeResponse.json({ key, value });
			}
			if (request.method === "PUT") {
				const value = (body as { value: string }).value;
				preferences = { ...preferences, [key]: value };
				return NativeResponse.json({ key, value });
			}
		}
		if (url.pathname === "/api/webhook-ingress/backend") {
			if (!ingress) {
				return NativeResponse.json({ error: "Not found" }, { status: 404 });
			}
			if (request.method === "GET") {
				return NativeResponse.json(ingress);
			}
			if (request.method === "POST") {
				const backend = (body as { backend: string }).backend;
				ingress = { ...ingress, backend };
				return NativeResponse.json({ backend, ok: true });
			}
		}
		if (route === "GET /api/gateway/config") {
			return NativeResponse.json({
				composioBillingActive: {
					baa: false,
					ipAllowlist: false,
					zeroDataRetention: false,
				},
				providers: {},
			});
		}
		unexpected.push(route);
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	return input instanceof URL ? input.href : input.url;
}
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (new URL(url).origin !== server.url.origin) {
			rejectedEgress.push(url);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;

const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => {
	unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { IntegrationsTab } = await import("./IntegrationsTab.tsx");
const { byLabel, click, flush, pressKey, settle, settingsRow } = await import(
	"./connections-providers.test-support.ts"
);

let root: Root | null = null;
let container: HTMLDivElement;

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<MemoryRouter>
				<IntegrationsTab />
				<Toaster position="bottom-right" />
			</MemoryRouter>
		)
	);
}

async function unmount() {
	const mounted = root;
	root = null;
	if (mounted) {
		await act(async () => mounted.unmount());
	}
}

function text(): string {
	return document.body.textContent ?? "";
}

function liveSwitch(): HTMLElement {
	const control = byLabel("Use live Artificial Analysis data", container);
	if (!control) {
		throw new Error("Missing live-data switch");
	}
	return control;
}

function isDisabled(element: HTMLElement): boolean {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.hasAttribute("data-disabled")
	);
}

function ingressTrigger(): HTMLElement | null {
	return byLabel("Webhook ingress backend", container);
}

function triggerLabel(): string {
	return ingressTrigger()?.textContent?.replace("▼", "").trim() ?? "";
}

function puts(path: string): unknown[] {
	return calls
		.filter((call) => call.method === "PUT" && call.path === path)
		.map((call) => call.body);
}

function posts(): unknown[] {
	return calls
		.filter(
			(call) =>
				call.method === "POST" && call.path === "/api/webhook-ingress/backend"
		)
		.map((call) => call.body);
}

/** Mount and wait until Core's saved values have unlocked the controls. */
async function mountLoaded() {
	await mount();
	await settle(() => !isDisabled(liveSwitch()), "preferences load", text);
}

async function mountWithIngress() {
	await mountLoaded();
	await settle(() => ingressTrigger() !== null, "ingress section", text);
}

async function toggleLive() {
	await click(liveSwitch());
}

function optionsShown(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function openIngressMenu() {
	const trigger = ingressTrigger();
	if (!trigger) {
		throw new Error("Missing ingress trigger");
	}
	await click(trigger);
	await settle(() => optionsShown().length > 0, "ingress options", text);
}

async function chooseIngress(label: string) {
	await openIngressMenu();
	const option = optionsShown().find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!option) {
		throw new Error(`Missing ingress option ${label}`);
	}
	await click(option);
}

beforeEach(async () => {
	preferences = {
		"aa-api-key": "aa-saved-key",
		"aa-mode": "cached",
		"hf-token": "hf-saved-token",
	};
	ingress = {
		available: [...AVAILABLE],
		backend: "tailscale-funnel",
		default: "ryu-relay",
	};
	refusals.clear();
	holds.clear();
	releases.clear();
	calls.length = 0;
	unexpected.length = 0;
	rejectedEgress.length = 0;
	unhandled.length = 0;
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: NODE.name,
		nodes: [{ name: NODE.name, token: NODE.token, url: server.url.origin }],
	});
	await act(async () => sileo.clear());
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	for (const release of releases.values()) {
		release();
	}
	await unmount();
	await act(async () => sileo.clear());
	container.remove();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case stays on declared, token-authenticated Core routes.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: no request may leave the loopback fixture.
	expect(rejectedEgress).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: a Core failure must surface in the tab, not as an unhandled rejection.
	expect(unhandled).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("Live data turns on as a realtime write, survives a remount, and turns off as a cached write without touching the saved keys", async () => {
	await mountLoaded();
	const row = settingsRow("Live data", container);
	expect(row).not.toBeNull();
	expect(row?.contains(liveSwitch())).toBe(true);
	expect(text()).toContain(
		"Off (default): cache the stats on this device and refresh once a day, which is kinder to the API's daily rate limit. On: fetch live every time."
	);
	expect(liveSwitch().getAttribute("aria-checked")).toBe("false");

	await toggleLive();
	await settle(
		() => text().includes("Using live Artificial Analysis data"),
		"live toast",
		text
	);
	expect(liveSwitch().getAttribute("aria-checked")).toBe("true");
	expect(puts("/api/preferences/aa-mode")).toEqual([{ value: "realtime" }]);
	expect(preferences["aa-mode"]).toBe("realtime");

	await unmount();
	await mountLoaded();
	expect(liveSwitch().getAttribute("aria-checked")).toBe("true");

	await toggleLive();
	await settle(
		() => text().includes("Using cached data"),
		"cached toast",
		text
	);
	expect(liveSwitch().getAttribute("aria-checked")).toBe("false");
	expect(puts("/api/preferences/aa-mode")).toEqual([
		{ value: "realtime" },
		{ value: "cached" },
	]);
	// Only the mode key was written; both saved credentials are conserved.
	expect(preferences).toEqual({
		"aa-api-key": "aa-saved-key",
		"aa-mode": "cached",
		"hf-token": "hf-saved-token",
	});
	expect(
		calls.filter((call) => call.method !== "GET").map((call) => call.path)
	).toEqual(["/api/preferences/aa-mode", "/api/preferences/aa-mode"]);
});

test("Live data stays disabled until Core answers, and a refused write rolls the switch back and can be retried", async () => {
	hold("GET /api/preferences/aa-mode");
	await mount();
	await settle(
		() => calls.some((call) => call.path === "/api/preferences/aa-mode"),
		"mode read",
		text
	);
	expect(isDisabled(liveSwitch())).toBe(true);
	await click(liveSwitch());
	expect(puts("/api/preferences/aa-mode")).toEqual([]);
	releases.get("GET /api/preferences/aa-mode")?.();
	await settle(() => !isDisabled(liveSwitch()), "mode loaded", text);

	refusals.set("PUT /api/preferences/aa-mode", {
		error: "Rate-limited preference write",
		status: 429,
	});
	await toggleLive();
	await settle(
		() => text().includes("Failed to update data mode"),
		"refusal toast",
		text
	);
	expect(liveSwitch().getAttribute("aria-checked")).toBe("false");
	expect(preferences["aa-mode"]).toBe("cached");

	await toggleLive();
	await settle(
		() => text().includes("Using live Artificial Analysis data"),
		"retry applied",
		text
	);
	expect(liveSwitch().getAttribute("aria-checked")).toBe("true");
	expect(puts("/api/preferences/aa-mode")).toEqual([
		{ value: "realtime" },
		{ value: "realtime" },
	]);
	expect(preferences["aa-mode"]).toBe("realtime");
});

test("Webhook ingress backend lists Core's offered backends, posts the exact choice, and reads it back after a remount", async () => {
	await mountWithIngress();
	expect(triggerLabel()).toBe("Tailscale Funnel");
	expect(
		settingsRow("Ingress backend", container)?.contains(ingressTrigger())
	).toBe(true);

	await openIngressMenu();
	expect(optionsShown().map((option) => option.textContent?.trim())).toEqual([
		"Ryu Relay (managed) (default)",
		"Tailscale Funnel",
		"Cloudflare Tunnel",
		"Self-hosted relay",
	]);
	const cloudflare = optionsShown().find(
		(option) => option.textContent?.trim() === "Cloudflare Tunnel"
	);
	if (!cloudflare) {
		throw new Error("Missing Cloudflare Tunnel option");
	}
	await click(cloudflare);
	await settle(
		() => text().includes("Ingress set to Cloudflare Tunnel"),
		"selection toast",
		text
	);
	expect(triggerLabel()).toBe("Cloudflare Tunnel");
	expect(posts()).toEqual([{ backend: "cloudflared" }]);
	expect(ingress?.backend).toBe("cloudflared");

	// Choosing the backend that is already active sends nothing.
	await chooseIngress("Cloudflare Tunnel");
	await flush();
	expect(posts()).toEqual([{ backend: "cloudflared" }]);

	await unmount();
	await mountWithIngress();
	expect(triggerLabel()).toBe("Cloudflare Tunnel");
	expect(preferences).toEqual({
		"aa-api-key": "aa-saved-key",
		"aa-mode": "cached",
		"hf-token": "hf-saved-token",
	});
});

test("a refused ingress selection restores the previous backend and shows Core's reason; the keyboard can retry it", async () => {
	await mountWithIngress();
	refusals.set("POST /api/webhook-ingress/backend", {
		error:
			"Self-hosted relay needs a public URL: save webhook.ingress.url or set RYU_WEBHOOK_INGRESS_URL.",
		status: 400,
	});
	await chooseIngress("Self-hosted relay");
	await settle(
		() => text().includes("Failed to set ingress backend"),
		"refusal toast",
		text
	);
	expect(text()).toContain(
		"Self-hosted relay needs a public URL: save webhook.ingress.url or set RYU_WEBHOOK_INGRESS_URL."
	);
	await settle(
		() => triggerLabel() === "Tailscale Funnel",
		"previous backend restored",
		text
	);
	expect(ingress?.backend).toBe("tailscale-funnel");

	// Keyboard retry: focus the trigger, open with ArrowDown, and pick with Enter.
	const trigger = ingressTrigger();
	if (!trigger) {
		throw new Error("Missing ingress trigger");
	}
	await act(async () => trigger.focus());
	expect(document.activeElement).toBe(trigger);
	await pressKey(trigger, "ArrowDown");
	await settle(() => optionsShown().length > 0, "keyboard-opened menu", text);
	const highlighted = () =>
		optionsShown().find((option) => option.hasAttribute("data-highlighted"));
	for (let step = 0; step < 8; step += 1) {
		if (highlighted()?.textContent?.trim() === "Cloudflare Tunnel") {
			break;
		}
		await pressKey(highlighted() ?? trigger, "ArrowDown");
	}
	const target = highlighted();
	expect(target?.textContent?.trim()).toBe("Cloudflare Tunnel");
	await pressKey(target ?? trigger, "Enter");
	await settle(
		() => triggerLabel() === "Cloudflare Tunnel",
		"keyboard pick",
		text
	);
	await settle(
		() => ingress?.backend === "cloudflared",
		"keyboard write",
		text
	);
	expect(posts()).toEqual([
		{ backend: "own-relay" },
		{ backend: "cloudflared" },
	]);
});

test("an older Core without webhook ingress hides the backend picker but keeps the credential rows", async () => {
	ingress = null;
	await mountLoaded();
	await flush();
	expect(ingressTrigger()).toBeNull();
	expect(text()).not.toContain("Webhook ingress");
	expect(byLabel("Hugging Face access token", container)).not.toBeNull();
	expect(settingsRow("Live data", container)).not.toBeNull();
});

function retryLoadButton(): HTMLButtonElement | null {
	return (
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) =>
				candidate.getAttribute("aria-label") ===
				"Retry loading integration settings"
		) ?? null
	);
}

const LOAD_FAILURE = "Couldn't read this node's saved integration settings.";

test("a failed read of the saved keys is reported with Retry and keeps their fields locked until a retry loads them", async () => {
	refusals.set("GET /api/preferences/hf-token", {
		error: "preference store locked",
		status: 500,
	});
	await mount();
	await settle(
		() => text().includes(LOAD_FAILURE),
		"load failure notice",
		text
	);
	// Nothing was loaded, so nothing may be edited over the unknown saved values.
	expect(isDisabled(liveSwitch())).toBe(true);
	expect(
		byLabel<HTMLInputElement>("Hugging Face access token", container)?.disabled
	).toBe(true);
	expect(
		byLabel<HTMLInputElement>("Artificial Analysis API key", container)
			?.disabled
	).toBe(true);
	// The relay URL read succeeded independently and stays editable.
	await settle(() => ingressTrigger() !== null, "ingress section", text);
	expect(
		byLabel<HTMLInputElement>("Self-hosted relay public URL", container)
			?.disabled
	).toBe(false);

	const retry = retryLoadButton();
	expect(retry).not.toBeNull();
	await click(retry as HTMLButtonElement);
	await settle(() => !isDisabled(liveSwitch()), "reloaded after retry", text);
	expect(
		byLabel<HTMLInputElement>("Hugging Face access token", container)?.value
	).toBe("hf-saved-token");
	expect(text()).not.toContain(LOAD_FAILURE);
	expect(retryLoadButton()).toBeNull();
	expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("a failed read of the saved relay URL is reported with Retry and keeps only that field locked", async () => {
	refusals.set("GET /api/preferences/webhook.ingress.url", {
		error: "preference store locked",
		status: 500,
	});
	await mountWithIngress();
	await settle(
		() => text().includes(LOAD_FAILURE),
		"load failure notice",
		text
	);
	expect(
		byLabel<HTMLInputElement>("Self-hosted relay public URL", container)
			?.disabled
	).toBe(true);
	expect(isDisabled(liveSwitch())).toBe(false);

	await click(retryLoadButton() as HTMLButtonElement);
	await settle(
		() =>
			byLabel<HTMLInputElement>("Self-hosted relay public URL", container)
				?.disabled === false,
		"relay URL loaded after retry",
		text
	);
	expect(text()).not.toContain(LOAD_FAILURE);
	expect(calls.every((call) => call.method === "GET")).toBe(true);
});
