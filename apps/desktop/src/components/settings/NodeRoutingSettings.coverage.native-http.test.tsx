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
import { TauriUnavailableError } from "@/src/lib/tauri-ready.ts";

// Control-level coverage for the shipping NodeRoutingSettings surface. Every
// request crosses real loopback HTTP: Core's preference route, the control
// plane's session/org/billing routes that decide the Business gate, and the
// public OpenRouter provider catalog (redirected from its fixed public URL to
// this fixture). Only the Tauri IPC bridge is an in-process fixture.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const ORG_ID = "org-node-routing-coverage";
const SESSION_TOKEN = "node-routing-coverage-session";
const NODE_TOKEN = "node-routing-coverage-node";
const USER_JWT = "node-routing-coverage-member-jwt";
const PUBLIC_CATALOG_URL = "https://openrouter.ai/api/v1/providers";
const ROUTING_PATH = "/api/preferences/node-routing-prefs";

/** The stored routing document a returning Business user already has. */
const SEED = {
	fallback: ["anthropic", "local"],
	firewall: {
		custom_patterns: [{ kind: "secret", name: "ticket_id", regex: "TCK-\\d+" }],
	},
	openrouter: { experimental_region: { pin: "eu-west" } },
	openrouter_model_fallbacks: ["openai/gpt-5-mini"],
};

interface Write {
	jwt: string | null;
	status: number;
	value: string;
}
interface CatalogRequest {
	authorization: string | null;
	cookie: string | null;
	jwt: string | null;
}

let storedRouting: string | null = null;
let writeStatus = 200;
let catalogStatus = 200;
let plan = "business";
let billingOrganizationId = ORG_ID;
let billingScope = "org";
let holdBilling = false;
let releaseBilling: (() => void) | null = null;
const writes: Write[] = [];
const catalogRequests: CatalogRequest[] = [];
const ipc: Array<{ command: string; args: unknown }> = [];
const unexpected: string[] = [];
const rejectedEgress: string[] = [];

function refuse(reason: string, status = 401) {
	unexpected.push(reason);
	return NativeResponse.json({ error: reason }, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const authorization = request.headers.get("authorization");
		if (url.pathname === "/openrouter/api/v1/providers") {
			catalogRequests.push({
				authorization,
				cookie: request.headers.get("cookie"),
				jwt: request.headers.get("x-ryu-user-jwt"),
			});
			if (catalogStatus !== 200) {
				return NativeResponse.json(
					{ error: "catalog down" },
					{ status: catalogStatus }
				);
			}
			return NativeResponse.json({
				data: [
					{ name: "Google Vertex", slug: "google-vertex" },
					{ name: "Azure", slug: "azure" },
					{ name: "Anthropic", slug: "anthropic" },
				],
			});
		}
		if (url.pathname === ROUTING_PATH) {
			if (authorization !== `Bearer ${NODE_TOKEN}`) {
				return refuse(`Core ${request.method} without the node token`);
			}
			if (request.method === "GET") {
				return storedRouting === null
					? NativeResponse.json({ error: "Unset preference" }, { status: 404 })
					: NativeResponse.json({
							key: "node-routing-prefs",
							value: storedRouting,
						});
			}
			if (request.method === "PUT") {
				const body = (await request.json()) as { value: string };
				writes.push({
					jwt: request.headers.get("x-ryu-user-jwt"),
					status: writeStatus,
					value: body.value,
				});
				if (writeStatus !== 200) {
					return NativeResponse.json(
						{ error: "Routing policy refused" },
						{ status: writeStatus }
					);
				}
				storedRouting = body.value;
				return NativeResponse.json({
					key: "node-routing-prefs",
					value: body.value,
				});
			}
		}
		if (request.method !== "GET") {
			return refuse(`Undeclared ${request.method} ${url.pathname}`, 405);
		}
		if (authorization !== `Bearer ${SESSION_TOKEN}`) {
			return refuse(`Control plane ${url.pathname} without the session`);
		}
		if (url.pathname === "/api/auth/token") {
			// The signed-in member's short-lived JWT that Core verifies.
			return NativeResponse.json({ token: USER_JWT });
		}
		if (url.pathname === "/api/auth/get-session") {
			return NativeResponse.json({
				session: { activeOrganizationId: ORG_ID },
			});
		}
		if (url.pathname === "/api/control-plane/orgs") {
			return NativeResponse.json({
				organizations: [
					{
						createdAt: null,
						id: ORG_ID,
						isPersonal: false,
						logo: null,
						name: "Routing coverage org",
						role: "owner",
						slug: "routing-coverage",
					},
				],
			});
		}
		if (url.pathname === "/api/billing/subscription-status") {
			if (holdBilling) {
				await new Promise<void>((resolve) => {
					releaseBilling = resolve;
				});
			}
			return NativeResponse.json({
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 0,
					plan,
					seats: 5,
				},
				organizationId: billingOrganizationId,
				plan,
				scope: billingScope,
				subscription: null,
			});
		}
		return refuse(`Undeclared GET ${url.pathname}`, 404);
	},
});

// The canonical build-time backend input must be set before production
// modules read it.
const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;
function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	return input instanceof URL ? input.href : input.url;
}
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url === PUBLIC_CATALOG_URL) {
			return nativeFetch(`${server.url.origin}/openrouter/api/v1/providers`, {
				...init,
				// The production call sends only Accept; keep exactly its headers.
				headers: init?.headers,
			});
		}
		if (new URL(url).origin !== server.url.origin) {
			rejectedEgress.push(url);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
window.fetch = globalThis.fetch;
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: unknown) => {
		// This harness has no sealed auth-vault slot: the vault seeded in
		// localStorage below is read as a host without one would.
		if (command.startsWith("desktop_secret_")) {
			return Promise.reject(new TauriUnavailableError(command));
		}
		ipc.push({ command, args });
		if (command !== "open_external") {
			unexpected.push(`IPC ${command}`);
		}
		return Promise.resolve(null);
	},
	transformCallback: () => 0,
});

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { BACKEND_URL, FRONTEND_URL, TOKEN_KEY } = await import(
	"@/lib/auth-client.ts"
);
const { OPENROUTER_PROVIDERS_URL } = await import(
	"@/src/lib/api/openrouter.ts"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { NodeRoutingSettings } = await import("./NodeRoutingSettings.tsx");

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "node-routing-coverage",
	nodes: [
		{
			name: "node-routing-coverage",
			url: server.url.origin,
			token: NODE_TOKEN,
		},
	],
});

let root: Root | null = null;
let container: HTMLDivElement;

async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${container.textContent}`);
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<>
				<NodeRoutingSettings />
				<Toaster position="bottom-right" />
			</>
		)
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

/** Mount and wait until Core's stored policy is loaded into the controls. */
async function mountLoaded() {
	await mount();
	await until(
		() => fallbackInput() !== null && !fallbackInput()!.disabled,
		"routing preferences load"
	);
}

/** Mount a Business view and wait for the OpenRouter controls to unlock. */
async function mountBusiness() {
	await mountLoaded();
	await until(
		() =>
			labelled("OpenRouter provider strategy") !== null &&
			!labelled<HTMLButtonElement>("OpenRouter provider strategy")!.disabled,
		"Business OpenRouter controls"
	);
}

async function remountBusiness() {
	await unmount();
	await mountBusiness();
}

function labelled<T extends HTMLElement = HTMLElement>(
	label: string,
	scope: ParentNode = container
): T | null {
	return scope.querySelector<T>(`[aria-label="${label}"]`);
}

function required<T extends HTMLElement = HTMLElement>(
	label: string,
	scope: ParentNode = container
): T {
	const found = labelled<T>(label, scope);
	if (!found) {
		throw new Error(`Missing control labelled ${label}`);
	}
	return found;
}

function fallbackInput() {
	return container.querySelector<HTMLInputElement>(
		'input[placeholder="anthropic, openrouter, local"]'
	);
}

function maybeButton(name: string, scope: ParentNode = container) {
	return (
		[...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) =>
				(candidate.getAttribute("aria-label") ??
					candidate.textContent?.trim()) === name
		) ?? null
	);
}

function button(name: string, scope: ParentNode = container) {
	const found = maybeButton(name, scope);
	if (!found) {
		throw new Error(`Missing button ${name}`);
	}
	return found;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

async function type(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
			element,
			value
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function pressEnter(element: HTMLElement) {
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: "Enter",
			})
		);
	});
}

/** The picker + list for the "Provider order" row. */
function orderEditor() {
	return button("Add provider").parentElement!.parentElement!;
}

/** The picker + chips for "Only these providers" or "Never use these providers". */
function listEditor(label: string) {
	const heading = [...container.querySelectorAll("p")].find(
		(paragraph) => paragraph.textContent === label
	);
	if (!heading) {
		throw new Error(`Missing provider list ${label}`);
	}
	return heading.parentElement!;
}

function orderedSlugs(scope: ParentNode) {
	return [...scope.querySelectorAll("li code")].map((code) => code.textContent);
}

function chipSlugs(scope: ParentNode) {
	return [...scope.querySelectorAll("span > code")].map(
		(code) => code.textContent
	);
}

function advancedJson() {
	return required<HTMLTextAreaElement>(
		"Advanced OpenRouter provider options JSON"
	);
}

function advancedValue() {
	return JSON.parse(advancedJson().value || "null");
}

function isChecked(element: HTMLElement) {
	return element.getAttribute("aria-checked") === "true";
}

function isDisabled(element: HTMLElement) {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.hasAttribute("data-disabled")
	);
}

function toastText() {
	return document.body.textContent ?? "";
}

async function save() {
	const before = writes.length;
	await click(button("Save routing preferences"));
	await until(
		() =>
			writes.length > before &&
			maybeButton("Save routing preferences")?.disabled === false &&
			toastText().includes(
				writes.at(-1)!.status === 200
					? "Routing preferences saved"
					: "Failed to save routing preferences"
			),
		"routing save"
	);
	return writes.at(-1)!;
}

function stored() {
	return JSON.parse(storedRouting ?? "null");
}

function strategyExpanded() {
	return (
		required("OpenRouter provider strategy").getAttribute("aria-expanded") ===
		"true"
	);
}

async function openStrategy() {
	await click(required("OpenRouter provider strategy"));
	await until(
		() =>
			strategyExpanded() &&
			document.querySelectorAll('[role="option"]').length > 0,
		"strategy options"
	);
}

async function chooseStrategy(name: string) {
	await openStrategy();
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((candidate) => candidate.textContent?.trim() === name);
	if (!option) {
		throw new Error(`Missing strategy option ${name}`);
	}
	await click(option);
	await until(() => !strategyExpanded(), "strategy popup close");
}

/** A select trigger's visible value, without its chevron glyph. */
function triggerValue(label: string) {
	return required(label).textContent?.replace("▼", "").trim();
}

function strategyLabel() {
	return triggerValue("OpenRouter provider strategy");
}

/** The inline validation message under the advanced JSON editor. */
function advancedError() {
	return advancedJson().parentElement!.querySelector("p.text-destructive")
		?.textContent;
}

beforeEach(async () => {
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must reach the loopback control plane, not a developer backend.
	expect(BACKEND_URL).toBe(server.url.origin);
	// biome-ignore lint/suspicious/noMisplacedAssertion: the redirect only applies to the production catalog URL.
	expect(OPENROUTER_PROVIDERS_URL).toBe(PUBLIC_CATALOG_URL);
	storedRouting = JSON.stringify(SEED);
	writeStatus = 200;
	catalogStatus = 200;
	plan = "business";
	billingOrganizationId = ORG_ID;
	billingScope = "org";
	holdBilling = false;
	releaseBilling = null;
	writes.length = 0;
	catalogRequests.length = 0;
	ipc.length = 0;
	unexpected.length = 0;
	rejectedEgress.length = 0;
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	releaseBilling?.();
	await unmount();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	container.remove();
	localStorage.removeItem(TOKEN_KEY);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated or undeclared requests.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects network access outside the fixtures.
	expect(rejectedEgress).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	if (previousBackend === undefined) {
		delete process.env.VITE_APP_BACKEND_URL;
	} else {
		process.env.VITE_APP_BACKEND_URL = previousBackend;
	}
});

// Ordering note: fetchOpenRouterProviders keeps a module-level five-minute
// cache after its first success. The two catalog cases therefore run first,
// with the catalog failing until the second one reloads it.
test("the Business gate hides OpenRouter controls for another plan, a mismatched organization, a personal subscription or a pending plan check, never fetches the catalog there, and View Business plans opens pricing", async () => {
	catalogStatus = 503;
	plan = "pro";
	await mountLoaded();
	await until(
		() => container.textContent!.includes("Business plan required"),
		"plan gate"
	);
	expect(labelled("OpenRouter provider strategy")).toBeNull();
	expect(labelled("OpenRouter provider slug")).toBeNull();
	expect(container.textContent).not.toContain("Saved for this organization");
	await click(button("View Business plans"));
	await until(() => ipc.length === 1, "pricing IPC");
	expect(ipc).toEqual([
		{
			command: "open_external",
			args: { url: `${FRONTEND_URL.replace(/\/$/, "")}/pricing#plans` },
		},
	]);

	await unmount();
	await act(async () => queryClient.clear());
	plan = "business";
	billingOrganizationId = "org-someone-else";
	await mountLoaded();
	await until(
		() => container.textContent!.includes("Business plan required"),
		"mismatched organization gate"
	);
	await act(async () => {
		await Bun.sleep(50);
	});
	expect(labelled("OpenRouter provider strategy")).toBeNull();
	expect(catalogRequests).toEqual([]);

	// A personal (user-scoped) Business subscription does not unlock the
	// organization's routing controls, even when it names this organization.
	await unmount();
	await act(async () => queryClient.clear());
	billingOrganizationId = ORG_ID;
	billingScope = "user";
	await mountLoaded();
	await until(
		() => container.textContent!.includes("Business plan required"),
		"user-scoped plan gate"
	);
	await act(async () => {
		await Bun.sleep(50);
	});
	expect(labelled("OpenRouter provider strategy")).toBeNull();
	expect(catalogRequests).toEqual([]);

	await unmount();
	await act(async () => queryClient.clear());
	billingScope = "org";
	holdBilling = true;
	await mountLoaded();
	await until(
		() =>
			container.textContent!.includes(
				"Checking the active organization's plan…"
			) && releaseBilling !== null,
		"pending plan check"
	);
	expect(labelled("OpenRouter provider strategy")).toBeNull();
	expect(catalogRequests).toEqual([]);
	holdBilling = false;
	await act(async () => releaseBilling!());
	await until(
		() => labelled("OpenRouter provider strategy") !== null,
		"Business controls after the plan check"
	);
	expect(container.textContent).toContain("Saved for this organization");
	expect(container.textContent).not.toContain("Business plan required");
	await until(() => catalogRequests.length === 1, "catalog request");
	// The public catalog request carries no account, node or org credential.
	expect(catalogRequests).toEqual([
		{ authorization: null, cookie: null, jwt: null },
	]);
});

test("a catalog outage keeps slug entry usable; Reload list refetches the public catalog and names known providers in the saved order", async () => {
	catalogStatus = 503;
	await mountBusiness();
	await until(
		() =>
			container.textContent!.includes(
				"Provider list is unavailable. You can still enter a slug."
			),
		"catalog outage notice"
	);
	expect(container.querySelectorAll("datalist option")).toHaveLength(0);
	const picker = required<HTMLInputElement>(
		"OpenRouter provider slug",
		orderEditor()
	);
	expect(picker.getAttribute("list")).toBe(
		container.querySelector("datalist")!.id
	);
	await type(picker, "Azure");
	await click(button("Add provider"));
	expect(orderedSlugs(orderEditor())).toEqual(["azure"]);
	// Without a catalog the row can only name the slug itself.
	expect(orderEditor().querySelector("li")!.textContent).toContain("1azure");

	catalogStatus = 200;
	await click(button("Reload list"));
	await until(
		() => container.querySelectorAll("datalist option").length === 3,
		"catalog reload"
	);
	expect(container.textContent).not.toContain("Provider list is unavailable");
	expect(
		[...container.querySelectorAll("datalist option")].map((option) => [
			option.getAttribute("value"),
			option.textContent,
		])
	).toEqual([
		["anthropic", "Anthropic"],
		["azure", "Azure"],
		["google-vertex", "Google Vertex"],
	]);
	expect(orderEditor().querySelector("li")!.textContent).toContain("Azure");
	expect(catalogRequests.length).toBe(2);
	expect(
		catalogRequests.every(
			(request) =>
				request.authorization === null &&
				request.cookie === null &&
				request.jwt === null
		)
	).toBe(true);

	const write = await save();
	expect(JSON.parse(write.value)).toEqual({
		...SEED,
		openrouter: { ...SEED.openrouter, order: ["azure"] },
	});
});

test("Provider order: Enter adds a trimmed lowercase slug and keeps focus, duplicates are ignored, Move up/down and Remove reorder, and the saved order reloads", async () => {
	await mountBusiness();
	const editor = orderEditor();
	expect(editor.textContent).toContain("No order is set.");
	const picker = required<HTMLInputElement>("OpenRouter provider slug", editor);
	expect(button("Add provider").disabled).toBe(true);
	await type(picker, "   ");
	expect(button("Add provider").disabled).toBe(true);

	picker.focus();
	await type(picker, " Google-Vertex ");
	await pressEnter(picker);
	expect(orderedSlugs(editor)).toEqual(["google-vertex"]);
	expect(picker.value).toBe("");
	expect(document.activeElement).toBe(picker);
	await type(picker, "azure");
	await pressEnter(picker);
	await type(picker, " AZURE ");
	await pressEnter(picker);
	expect(orderedSlugs(editor)).toEqual(["google-vertex", "azure"]);
	expect(button("Move google-vertex up").disabled).toBe(true);
	expect(button("Move azure down").disabled).toBe(true);
	await click(button("Move azure up"));
	expect(orderedSlugs(editor)).toEqual(["azure", "google-vertex"]);
	await click(button("Move azure down"));
	await click(button("Move azure up"));
	await type(picker, "custom-edge");
	await click(button("Add provider"));
	expect(orderedSlugs(editor)).toEqual([
		"azure",
		"google-vertex",
		"custom-edge",
	]);
	await click(button("Remove custom-edge", editor));
	expect(orderedSlugs(editor)).toEqual(["azure", "google-vertex"]);
	// The advanced editor mirrors the typed control.
	expect(advancedValue()).toEqual({
		...SEED.openrouter,
		order: ["azure", "google-vertex"],
	});

	const write = await save();
	expect(write.status).toBe(200);
	// Core receives the write under the node token and the signed-in member's
	// JWT minted by the control plane.
	expect(write.jwt).toBe(USER_JWT);
	expect(stored()).toEqual({
		...SEED,
		openrouter: { ...SEED.openrouter, order: ["azure", "google-vertex"] },
	});

	await remountBusiness();
	expect(orderedSlugs(orderEditor())).toEqual(["azure", "google-vertex"]);
	expect(
		[...orderEditor().querySelectorAll("li")].map(
			(row) => row.querySelector("span span")!.textContent
		)
	).toEqual(["1", "2"]);
	await click(button("Remove azure", orderEditor()));
	await click(button("Remove google-vertex", orderEditor()));
	expect(orderEditor().textContent).toContain("No order is set.");
	await save();
	expect(stored()).toEqual(SEED);
});

test("Only these and Never use these providers add, dedupe and remove independently; emptying a list removes it from the saved policy", async () => {
	await mountBusiness();
	const only = listEditor("Only these providers");
	const never = listEditor("Never use these providers");
	const onlyPicker = required<HTMLInputElement>(
		"OpenRouter provider slug",
		only
	);
	const neverPicker = required<HTMLInputElement>(
		"OpenRouter provider slug",
		never
	);
	expect(button("Add", only).disabled).toBe(true);
	await type(onlyPicker, "Azure");
	await click(button("Add", only));
	await type(onlyPicker, "google-vertex");
	await pressEnter(onlyPicker);
	await type(onlyPicker, "azure");
	await click(button("Add", only));
	await type(neverPicker, " Anthropic ");
	await pressEnter(neverPicker);
	expect(chipSlugs(only)).toEqual(["azure", "google-vertex"]);
	expect(chipSlugs(never)).toEqual(["anthropic"]);
	// Chips name catalog providers.
	expect(only.textContent).toContain("Google Vertex");
	expect(never.textContent).toContain("Anthropic");
	await click(button("Remove azure", only));
	expect(chipSlugs(only)).toEqual(["google-vertex"]);
	expect(chipSlugs(never)).toEqual(["anthropic"]);

	await save();
	expect(stored()).toEqual({
		...SEED,
		openrouter: {
			...SEED.openrouter,
			ignore: ["anthropic"],
			only: ["google-vertex"],
		},
	});

	await remountBusiness();
	expect(chipSlugs(listEditor("Only these providers"))).toEqual([
		"google-vertex",
	]);
	expect(chipSlugs(listEditor("Never use these providers"))).toEqual([
		"anthropic",
	]);
	await click(
		button("Remove anthropic", listEditor("Never use these providers"))
	);
	await save();
	expect(stored()).toEqual({
		...SEED,
		openrouter: { ...SEED.openrouter, only: ["google-vertex"] },
	});
});

test("Provider strategy saves each sort, the default removes it, and a stored unknown sort shows Custom and survives choosing Custom", async () => {
	storedRouting = JSON.stringify({
		...SEED,
		openrouter: { ...SEED.openrouter, sort: "region-latency" },
	});
	await mountBusiness();
	expect(strategyLabel()).toBe("Custom (advanced JSON)");
	await openStrategy();
	expect(
		[...document.querySelectorAll('[role="option"]')].map((option) =>
			option.textContent?.trim()
		)
	).toEqual([
		"OpenRouter health-aware default",
		"Higher throughput first",
		"Lower latency first",
		"Lower price first",
		"Custom (advanced JSON)",
	]);
	await act(async () => {
		document
			.querySelector('[role="option"]')!
			.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
	});
	await until(() => !strategyExpanded(), "strategy popup close");
	await chooseStrategy("Custom (advanced JSON)");
	expect(advancedValue().sort).toBe("region-latency");

	await chooseStrategy("Higher throughput first");
	expect(strategyLabel()).toBe("Higher throughput first");
	expect(advancedValue().sort).toBe("throughput");
	await save();
	expect(stored().openrouter).toEqual({
		...SEED.openrouter,
		sort: "throughput",
	});

	await chooseStrategy("Lower latency first");
	await chooseStrategy("Lower price first");
	await save();
	expect(stored().openrouter.sort).toBe("price");
	await remountBusiness();
	expect(strategyLabel()).toBe("Lower price first");

	await chooseStrategy("OpenRouter health-aware default");
	expect(strategyLabel()).toBe("OpenRouter health-aware default");
	await save();
	expect(stored()).toEqual(SEED);
});

test("Allow provider fallbacks saves false when off and removes it when on; model fallbacks are trimmed, deduplicated, ordered and removable", async () => {
	await mountBusiness();
	const fallbacks = required("Allow provider fallbacks");
	expect(isChecked(fallbacks)).toBe(true);
	await click(fallbacks);
	expect(isChecked(required("Allow provider fallbacks"))).toBe(false);
	await save();
	expect(stored().openrouter).toEqual({
		...SEED.openrouter,
		allow_fallbacks: false,
	});
	await remountBusiness();
	expect(isChecked(required("Allow provider fallbacks"))).toBe(false);
	await click(required("Allow provider fallbacks"));
	expect(isChecked(required("Allow provider fallbacks"))).toBe(true);

	const model = required<HTMLInputElement>("OpenRouter fallback model id");
	expect(button("Add model").disabled).toBe(true);
	model.focus();
	await type(model, " anthropic/claude-sonnet-4.6 ");
	await pressEnter(model);
	expect(model.value).toBe("");
	expect(document.activeElement).toBe(model);
	await type(model, "anthropic/claude-sonnet-4.6");
	await click(button("Add model"));
	await type(model, "google/gemini-2.5-pro");
	await click(button("Add model"));
	await click(button("Remove fallback model openai/gpt-5-mini"));
	await save();
	expect(stored()).toEqual({
		...SEED,
		openrouter_model_fallbacks: [
			"anthropic/claude-sonnet-4.6",
			"google/gemini-2.5-pro",
		],
	});
	await remountBusiness();
	const rows = [
		...required("OpenRouter fallback model id")
			.closest("div.space-y-2")!
			.querySelectorAll("li"),
	].map((row) => row.querySelector("span")!.textContent);
	expect(rows).toEqual([
		"1.anthropic/claude-sonnet-4.6",
		"2.google/gemini-2.5-pro",
	]);
});

test("the privacy controls stay locked on: ZDR and data-collecting provider exclusion cannot be changed or written as editable preferences", async () => {
	await mountBusiness();
	const zdr = required("Require Zero Data Retention (ZDR)");
	const collection = required<HTMLButtonElement>("OpenRouter data collection");
	expect(isChecked(zdr)).toBe(true);
	expect(isDisabled(zdr)).toBe(true);
	expect(isDisabled(collection)).toBe(true);
	expect(triggerValue("OpenRouter data collection")).toBe(
		"Exclude data-collecting providers"
	);
	await click(zdr);
	await click(collection);
	await act(async () => {
		await Bun.sleep(30);
	});
	expect(isChecked(required("Require Zero Data Retention (ZDR)"))).toBe(true);
	expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
	const write = await save();
	// Gateway owns the locked privacy policy; the stored routing document is
	// returned exactly as the user left it.
	expect(JSON.parse(write.value)).toEqual(SEED);
});

test("Provider requirements write exact parameter-support and distillable-text options, reload them, and remove each when cleared", async () => {
	await mountBusiness();
	const parameters = required("Require parameter support");
	const distillable = required("Require distillable text");
	expect(isChecked(parameters)).toBe(false);
	expect(isChecked(distillable)).toBe(false);
	await click(parameters);
	await click(required("Require distillable text"));
	// Quantization checkboxes sit inside <label> wrappers whose activation
	// happy-dom does not model; node-routing-coverage.spec.ts drives them in
	// Chromium.
	await save();
	expect(stored().openrouter).toEqual({
		...SEED.openrouter,
		enforce_distillable_text: true,
		require_parameters: true,
	});

	await remountBusiness();
	expect(isChecked(required("Require parameter support"))).toBe(true);
	expect(isChecked(required("Require distillable text"))).toBe(true);
	await click(required("Require parameter support"));
	await save();
	expect(stored().openrouter).toEqual({
		...SEED.openrouter,
		enforce_distillable_text: true,
	});
});

test("Performance percentiles and maximum prices write numeric options; a blank input removes only its own key", async () => {
	storedRouting = JSON.stringify({
		...SEED,
		openrouter: { ...SEED.openrouter, preferred_max_latency: 3 },
	});
	await mountBusiness();
	// A scalar stored preference is OpenRouter's p50 shorthand.
	expect(
		required<HTMLInputElement>("Preferred maximum latency p50").value
	).toBe("3");
	await type(
		required<HTMLInputElement>("Preferred minimum throughput p50"),
		"120"
	);
	await type(
		required<HTMLInputElement>("Preferred minimum throughput p90"),
		"40"
	);
	await type(
		required<HTMLInputElement>("Preferred maximum latency p99"),
		"2.5"
	);
	await type(
		required<HTMLInputElement>("Preferred minimum throughput p90"),
		""
	);
	await type(
		required<HTMLInputElement>("Prompt ($ per million tokens)"),
		"2.5"
	);
	await type(
		required<HTMLInputElement>("Completion ($ per million tokens)"),
		"10"
	);
	await type(required<HTMLInputElement>("Request ($ per request)"), "0.01");
	await type(required<HTMLInputElement>("Image ($ per image)"), "0.5");
	await type(required<HTMLInputElement>("Request ($ per request)"), "");
	await save();
	expect(stored().openrouter).toEqual({
		...SEED.openrouter,
		max_price: { completion: 10, image: 0.5, prompt: 2.5 },
		preferred_max_latency: { p50: 3, p99: 2.5 },
		preferred_min_throughput: { p50: 120 },
	});

	await remountBusiness();
	expect(
		[
			"Preferred minimum throughput p50",
			"Preferred minimum throughput p90",
			"Preferred maximum latency p50",
			"Preferred maximum latency p99",
			"Prompt ($ per million tokens)",
			"Completion ($ per million tokens)",
			"Request ($ per request)",
			"Image ($ per image)",
		].map((label) => required<HTMLInputElement>(label).value)
	).toEqual(["120", "", "3", "2.5", "2.5", "10", "", "0.5"]);
	for (const label of [
		"Preferred minimum throughput p50",
		"Preferred maximum latency p50",
		"Preferred maximum latency p99",
		"Prompt ($ per million tokens)",
		"Completion ($ per million tokens)",
		"Image ($ per image)",
	]) {
		await type(required<HTMLInputElement>(label), "");
	}
	await save();
	expect(stored()).toEqual(SEED);
});

test("Advanced provider JSON mirrors typed edits, blocks Save while invalid, re-enables typed controls when fixed, conserves unknown fields, and enforces the size limit", async () => {
	await mountBusiness();
	await click(required("Require parameter support"));
	expect(advancedValue()).toEqual({
		...SEED.openrouter,
		require_parameters: true,
	});

	await type(advancedJson(), "{ not json");
	expect(advancedError()).toBe(
		"Advanced OpenRouter options must be valid JSON."
	);
	expect(
		required<HTMLButtonElement>("OpenRouter provider strategy").disabled
	).toBe(true);
	expect(isDisabled(required("Require distillable text"))).toBe(true);
	expect(
		required<HTMLInputElement>("Prompt ($ per million tokens)").disabled
	).toBe(true);
	expect(
		[
			...container.querySelectorAll<HTMLInputElement>(
				'[aria-label="OpenRouter provider slug"]'
			),
		].map((picker) => picker.disabled)
	).toEqual([true, true, true]);
	expect(
		required<HTMLInputElement>("OpenRouter fallback model id").disabled
	).toBe(true);
	await click(button("Save routing preferences"));
	await until(
		() => toastText().includes("Could not save routing preferences"),
		"invalid JSON toast"
	);
	expect(writes).toEqual([]);

	await type(advancedJson(), "[1, 2]");
	expect(advancedError()).toBe(
		"Advanced OpenRouter options must be a JSON object."
	);

	await type(
		advancedJson(),
		JSON.stringify({ future_field: { tier: 2 }, sort: "latency" })
	);
	expect(advancedError()).toBeUndefined();
	expect(strategyLabel()).toBe("Lower latency first");
	expect(isChecked(required("Require parameter support"))).toBe(false);
	expect(isDisabled(required("Require distillable text"))).toBe(false);
	await click(required("Require distillable text"));
	expect(advancedValue()).toEqual({
		enforce_distillable_text: true,
		future_field: { tier: 2 },
		sort: "latency",
	});
	await save();
	expect(stored()).toEqual({
		...SEED,
		openrouter: {
			enforce_distillable_text: true,
			future_field: { tier: 2 },
			sort: "latency",
		},
	});
	const accepted = storedRouting;

	await type(
		advancedJson(),
		JSON.stringify({ note: "x".repeat(3100), sort: "price" })
	);
	await click(button("Save routing preferences"));
	await until(
		() => toastText().includes("Routing preferences are too large"),
		"size limit toast"
	);
	expect(writes).toHaveLength(1);
	expect(storedRouting).toBe(accepted);

	await type(advancedJson(), "");
	expect(strategyLabel()).toBe("OpenRouter health-aware default");
	await save();
	const { openrouter: _removed, ...withoutProvider } = SEED;
	expect(stored()).toEqual(withoutProvider);
});

test("Extra firewall rules and preferred fallbacks: malformed rules are refused before any Core write, valid rules and provider ids are trimmed, and a blank rules field clears them", async () => {
	await mountBusiness();
	const rules = required<HTMLTextAreaElement>("Extra firewall rules JSON");
	expect(JSON.parse(rules.value)).toEqual(SEED.firewall.custom_patterns);
	expect(fallbackInput()!.value).toBe("anthropic, local");
	await type(fallbackInput()!, "  openrouter , , anthropic  ");
	for (const [raw, message] of [
		["{ invalid", "Extra firewall rules must be valid JSON."],
		["{}", "Extra firewall rules must be a JSON array."],
		[
			'[{"kind":"unsupported","name":"private","regex":"x"}]',
			"Each rule needs a kind (pii, secret, or prompt_injection), name, and regex.",
		],
	] as const) {
		await act(async () => sileo.clear());
		await type(rules, raw);
		await click(button("Save routing preferences"));
		await until(() => toastText().includes(message), message);
		expect(rules.value).toBe(raw);
		expect(fallbackInput()!.value).toBe("  openrouter , , anthropic  ");
	}
	expect(writes).toEqual([]);

	await type(
		rules,
		JSON.stringify([
			{ kind: "pii", name: " badge_number ", regex: " B-[0-9]{6} " },
		])
	);
	await save();
	expect(stored()).toEqual({
		...SEED,
		fallback: ["openrouter", "anthropic"],
		firewall: {
			custom_patterns: [
				{ kind: "pii", name: "badge_number", regex: "B-[0-9]{6}" },
			],
		},
	});
	await remountBusiness();
	expect(fallbackInput()!.value).toBe("openrouter, anthropic");
	await type(required<HTMLTextAreaElement>("Extra firewall rules JSON"), "");
	await save();
	const { firewall: _cleared, ...withoutFirewall } = SEED;
	expect(stored()).toEqual({
		...withoutFirewall,
		fallback: ["openrouter", "anthropic"],
	});
});

test("a refused save of OpenRouter edits keeps every typed draft, unlocks retry, and the retry writes the identical document", async () => {
	await mountBusiness();
	await chooseStrategy("Higher throughput first");
	await type(required<HTMLInputElement>("Prompt ($ per million tokens)"), "4");
	const only = listEditor("Only these providers");
	await type(
		required<HTMLInputElement>("OpenRouter provider slug", only),
		"azure"
	);
	await click(button("Add", only));
	writeStatus = 500;
	const refused = await save();
	expect(refused.status).toBe(500);
	expect(toastText()).toContain("Core did not accept the change.");
	expect(stored()).toEqual(SEED);
	expect(strategyLabel()).toBe("Higher throughput first");
	expect(
		required<HTMLInputElement>("Prompt ($ per million tokens)").value
	).toBe("4");
	expect(chipSlugs(listEditor("Only these providers"))).toEqual(["azure"]);

	writeStatus = 200;
	await act(async () => sileo.clear());
	const retried = await save();
	expect(retried.value).toBe(refused.value);
	expect(stored()).toEqual({
		...SEED,
		openrouter: {
			...SEED.openrouter,
			max_price: { prompt: 4 },
			only: ["azure"],
			sort: "throughput",
		},
	});
	await remountBusiness();
	expect(strategyLabel()).toBe("Higher throughput first");
	expect(
		required<HTMLInputElement>("Prompt ($ per million tokens)").value
	).toBe("4");
});
