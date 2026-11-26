import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { PiAccount, PiProvider } from "@/src/lib/api/pi-config.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://credential-routing.fixture",
	token: "routing-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { ProviderCredentialRouting } = await import(
	"./ProviderCredentialRouting.tsx"
);

const originalFetch = globalThis.fetch;
const roots: Root[] = [];
const client = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

interface Call {
	body: unknown;
	method: string;
	path: string;
}
let calls: Call[];
/** What Core holds for the fallback setting of claude-pro-max. */
let fallbackOn: boolean;
let credentialsRoute: "present" | "missing";
let refuseSave: boolean;

const account = (
	accountId: string,
	label: string,
	kind: PiAccount["kind"]
): PiAccount => ({
	accountId,
	label,
	kind,
	active: false,
	gatewayActive: false,
	updatedAt: 0,
});
const row = (item: PiAccount, hint?: string) => ({
	accountId: item.accountId,
	label: item.label,
	kind: item.kind,
	enabled: true,
	needsReauth: false,
	...(hint ? { hint } : {}),
});
const WORK = account("key-work", "Work", "api_key");
const SPARE = account("key-spare", "Spare", "api_key");
const LOGIN = account("login-a", "a@example.com", "oauth");

const provider = (change: Partial<PiProvider>): PiProvider =>
	// SAFETY: the component reads only id, accounts and accountRouting.
	({ id: "anthropic", ...change }) as PiProvider;
const ANTHROPIC = provider({
	id: "anthropic",
	accounts: [WORK, SPARE],
	accountRouting: {
		credentialKinds: ["api_key"],
		quotaObservations: false,
		strategies: ["manual", "round_robin", "fill_first"],
	},
});
const CLAUDE = provider({
	id: "claude-pro-max",
	// The Claude card lists its sign-ins; the Anthropic keys share its store.
	accounts: [LOGIN, WORK],
	accountRouting: {
		credentialKinds: ["oauth"],
		quotaObservations: false,
		strategies: ["manual", "round_robin"],
	},
});

function credentials(providerId: string) {
	if (providerId === "claude-pro-max") {
		return {
			providerId,
			credentials: [row(LOGIN)],
			apiKeyFallback: {
				supported: true,
				enabled: fallbackOn,
				keyProviderId: "anthropic",
				keys: [row(SPARE, "0002"), row(WORK, "0001")],
			},
		};
	}
	return {
		providerId,
		credentials: [row(SPARE, "0002"), row(WORK, "0001")],
		apiKeyFallback: { supported: false, enabled: false, keys: [] },
	};
}

function answer(call: Call): Response {
	const match = /^\/api\/pi-config\/providers\/([^/]+)\/(.+)$/.exec(call.path);
	const providerId = decodeURIComponent(match?.[1] ?? "");
	if (match?.[2] === "account-pool") {
		return Response.json({
			strategy: "round_robin",
			drainThresholdPercent: 80,
			accounts: {
				"key-spare": { enabled: true, priority: 0 },
				"key-work": { enabled: true, priority: 1 },
			},
		});
	}
	if (match?.[2] !== "credentials" || credentialsRoute === "missing") {
		return new Response("not found", { status: 404 });
	}
	if (call.method === "PUT") {
		if (refuseSave) {
			return Response.json({ error: "refused" }, { status: 500 });
		}
		fallbackOn =
			(call.body as { apiKeyFallback?: boolean } | null)?.apiKeyFallback ===
			true;
	}
	return Response.json(credentials(providerId));
}

beforeEach(() => {
	calls = [];
	fallbackOn = false;
	credentialsRoute = "present";
	refuseSave = false;
	client.clear();
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const call: Call = {
				path: new URL(String(input)).pathname,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return answer(call);
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

async function settle() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount(item: PiProvider) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ProviderCredentialRouting provider={item} />
			</QueryClientProvider>
		)
	);
	await settle();
}

const rows = () =>
	[...document.querySelectorAll("[data-credential-row]")].map((element) =>
		element.getAttribute("data-credential-row")
	);
const rowText = (id: string) =>
	document.querySelector(`[data-credential-row="${id}"]`)?.textContent ?? "";
const fallbackSection = () =>
	document.querySelector<HTMLElement>('[data-slot="api-key-fallback"]');
function fallbackSwitch() {
	const element =
		fallbackSection()?.querySelector<HTMLElement>('[role="switch"]');
	if (!element) {
		throw new Error("Missing fallback switch");
	}
	return element;
}
const credentialCalls = () =>
	calls
		.filter((call) => call.path.endsWith("/credentials"))
		.map((call) => [call.method, call.path, call.body]);

test("a provider with no account routing shows nothing and asks nothing", async () => {
	await mount(provider({ id: "ollama", accounts: [WORK] }));
	expect(document.body.textContent).toBe("");
	expect(calls).toEqual([]);
});

test("a provider with routing but no account of a routed kind shows nothing", async () => {
	await mount(provider({ ...CLAUDE, accounts: [WORK] }));
	expect(rows()).toEqual([]);
	expect(calls).toEqual([]);
});

test("API keys are listed in saved order, each with the end of its key", async () => {
	await mount(ANTHROPIC);
	expect(rows()).toEqual(["key-spare", "key-work"]);
	expect(rowText("key-spare")).toContain("Key ending in 0002");
	expect(rowText("key-work")).toContain("Key ending in 0001");
	expect(credentialCalls()).toEqual([
		["GET", "/api/pi-config/providers/anthropic/credentials", null],
	]);
	// Anthropic keys have no subscription to stand in for.
	expect(fallbackSection()).toBeNull();
});

test("the Claude card lists only its sign-ins and offers the fallback, off at first", async () => {
	await mount(CLAUDE);
	expect(rows()).toEqual(["login-a"]);
	expect(fallbackSwitch().getAttribute("aria-checked")).toBe("false");
	expect(document.querySelector('[data-slot="fallback-keys"]')).toBeNull();
});

test("turning the fallback on saves it and then lists the keys that take over", async () => {
	await mount(CLAUDE);
	await act(async () => fallbackSwitch().click());
	await settle();
	expect(credentialCalls()).toEqual([
		["GET", "/api/pi-config/providers/claude-pro-max/credentials", null],
		[
			"PUT",
			"/api/pi-config/providers/claude-pro-max/credentials",
			{ apiKeyFallback: true },
		],
	]);
	expect(fallbackSwitch().getAttribute("aria-checked")).toBe("true");
	expect(
		[...document.querySelectorAll('[data-slot="fallback-keys"] > li')].map(
			(item) => item.textContent
		)
	).toEqual(["1SpareKey ending in 0002Ready", "2WorkKey ending in 0001Ready"]);

	await act(async () => fallbackSwitch().click());
	await settle();
	expect(credentialCalls().at(-1)).toEqual([
		"PUT",
		"/api/pi-config/providers/claude-pro-max/credentials",
		{ apiKeyFallback: false },
	]);
	expect(fallbackSwitch().getAttribute("aria-checked")).toBe("false");
});

test("a save Core refuses leaves the fallback off", async () => {
	refuseSave = true;
	await mount(CLAUDE);
	await act(async () => fallbackSwitch().click());
	await settle();
	expect(fallbackOn).toBe(false);
	expect(fallbackSwitch().getAttribute("aria-checked")).toBe("false");
	expect(document.querySelector('[data-slot="fallback-keys"]')).toBeNull();
});

test("an older Core without the route still shows the list, without hints or the setting", async () => {
	credentialsRoute = "missing";
	await mount(ANTHROPIC);
	expect(rows()).toEqual(["key-spare", "key-work"]);
	expect(rowText("key-work")).not.toContain("Key ending in");
	expect(fallbackSection()).toBeNull();
});
