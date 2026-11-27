// One provider's page mounted alone, with its host's callbacks as spies: the
// heading and the line under it, the sections each kind of provider gets, and
// the controls a user works on the page (routing, models, the key check, the
// danger zone, the prepaid credits offer, the way to the pools page).

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { ProviderCardProps } from "../LlmProvidersSettings-shared.ts";
import type { ManagedFunding } from "./provider-pages-model.ts";

const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { MemoryRouter } = await import("react-router-dom");
const { sileo } = await import("sileo");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useGatewayDialog } = await import("@/src/store/useGatewayDialog.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useSettingsDialog } = await import("@/src/store/useSettingsDialog.ts");
const { ProviderPage } = await import("./ProviderPage.tsx");

const node: Node = {
	name: "provider-page",
	url: "https://provider-page.fixture:7980",
	token: "provider-page-token",
	userJwt: null,
};

const POOLS = "/api/pi-config/providers/account-pools";
const POOL_CATALOG = {
	agents: {},
	maxPoolAccounts: 200,
	maxPools: 50,
	pools: [
		{
			accounts: [{ accountId: "work", providerId: "claude-pro-max" }],
			id: "pool-1",
			name: "Mythos",
		},
	],
};

function account(accountId: string, label: string, extra: object = {}) {
	return {
		accountId,
		active: false,
		gatewayActive: false,
		kind: "oauth",
		label,
		updatedAt: 0,
		...extra,
	};
}

function provider(id: string, label: string, extra: object = {}): PiProvider {
	return {
		api: "openai-completions",
		authEnv: "",
		authKind: "api-key",
		configured: false,
		custom: false,
		id,
		label,
		routing: "gateway",
		suggestedModels: [],
		supportsDiscovery: false,
		...extra,
	} as PiProvider;
}

const CLAUDE = provider("claude-pro-max", "Claude Pro/Max", {
	accountRouting: {
		credentialKinds: ["oauth"],
		quotaObservations: false,
		strategies: ["manual", "round_robin"],
	},
	accounts: [
		account("work", "work@example.com", { active: true }),
		account("home", "home@example.com", { needsReauth: true }),
	],
	api: "anthropic-messages",
	authKind: "subscription",
	configured: true,
	routing: "direct",
	supportsOAuth: true,
});
const OPENAI = provider("openai", "OpenAI", {
	accounts: [account("key-1", "Team key", { kind: "api_key" })],
	active: true,
	configured: true,
	suggestedModels: ["gpt-5.2"],
});
const GROQ = provider("groq", "Groq");
const RYU = provider("gateway", "Ryu", {
	authKind: "none",
	configured: true,
	creditPool: "openrouter",
	managed: true,
	routingLocked: true,
});

const funds = (managedInference: boolean): ManagedFunding => ({
	hasPrepaidBalance: false,
	managedInference,
});
const PAID = funds(true);
const UNPAID = funds(false);

const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
/** Every call of a host callback, by the name of the prop. */
let seen: Record<string, unknown[][]> = {};
/** Set to make the host's callbacks fail the way a refusal from Core does. */
let refuse: string | null = null;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;

function record(name: string, ...args: unknown[]) {
	seen[name] = [...(seen[name] ?? []), args];
}

type Callbacks = Omit<
	ProviderCardProps,
	"activeConfig" | "hasPrepaidManagedBalance" | "provider"
>;

/** The host's callbacks: each one records its call and answers like Core. */
function callbacks(): Callbacks {
	const done =
		(name: string, answer?: unknown) =>
		async (...args: unknown[]) => {
			record(name, ...args);
			if (refuse !== null) {
				throw new Error(refuse);
			}
			return await Promise.resolve(answer);
		};
	return {
		check: done("check", { latencyMs: 120, modelCount: 4, ok: true }),
		discover: done("discover", {
			models: [{ id: "gpt-5.2" }, { id: "gpt-5.2-mini", name: "GPT 5.2 mini" }],
			source: "live",
		}),
		onActivate: done("onActivate"),
		onConfigure: done("onConfigure"),
		onReload: () => record("onReload"),
		onRemove: done("onRemove"),
		onRemoveAccount: done("onRemoveAccount"),
		onRenameAccount: done("onRenameAccount"),
		onSwitchAccount: done("onSwitchAccount"),
		onToggleModel: done("onToggleModel"),
		thinkingLevels: ["off", "high"],
	} as unknown as Callbacks;
}

beforeEach(() => {
	seen = {};
	refuse = null;
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		nodes: [node],
	});
	successToast = spyOn(sileo, "success");
	errorToast = spyOn(sileo, "error");
	// The page gets its provider from its host. Of Core's routes only the pool
	// catalog answers here; every other one is "not found".
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			return await Promise.resolve(
				url.pathname === POOLS
					? NativeResponse.json(POOL_CATALOG)
					: NativeResponse.json({ error: "undeclared" }, { status: 404 })
			);
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
	document.body.replaceChildren();
	successToast.mockRestore();
	errorToast.mockRestore();
	globalThis.fetch = originalFetch;
	useNodeStore.setState(originalNodes);
	useGatewayDialog.setState({ open: false });
	useSettingsDialog.setState({ open: false });
});

async function settle(ms = 20) {
	await act(async () => {
		await Bun.sleep(ms);
	});
}

async function until(predicate: () => boolean, reason: string) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle(10);
	}
	throw new Error(`${reason}: ${document.body.textContent}`);
}

interface PageOptions {
	funding?: ManagedFunding;
	hasPrepaidManagedBalance?: boolean;
}

async function mount(
	shown: PiProvider,
	{ funding = PAID, hasPrepaidManagedBalance = false }: PageOptions = {}
): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const client = new QueryClient({
		defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<EntitlementProvider>
						<ProviderPage
							{...callbacks()}
							activeConfig={null}
							funding={funding}
							hasPrepaidManagedBalance={hasPrepaidManagedBalance}
							onBack={() => record("onBack")}
							onManagePools={() => record("onManagePools")}
							parentTitle="AI providers"
							provider={shown}
						/>
					</EntitlementProvider>
				</MemoryRouter>
			</QueryClientProvider>
		)
	);
	await until(
		() => host.querySelector("[data-provider-page]") !== null,
		"page never shown"
	);
	await settle();
	return host;
}

function one<T extends HTMLElement = HTMLElement>(
	scope: ParentNode,
	selector: string
): T {
	const element = scope.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}: ${document.body.textContent}`);
	}
	return element;
}

function section(host: HTMLElement, name: string): HTMLElement {
	return one(host, `[data-provider-page-section="${name}"]`);
}

/** The headings of the sections on the page, top to bottom. */
function outline(host: HTMLElement): string[] {
	return Array.from(
		host.querySelectorAll("[data-provider-page-section] h3")
	).map((heading) => heading.textContent ?? "");
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
	const found = Array.from(scope.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label
	);
	if (!found) {
		throw new Error(`Missing button ${label}: ${document.body.textContent}`);
	}
	return found;
}

/**
 * The control a visible label names: a native field through `for`, a switch
 * (a custom control over a hidden checkbox) by pointing back at the label.
 */
function labelled(scope: HTMLElement, text: string): HTMLElement {
	const label = Array.from(scope.querySelectorAll("label")).find(
		(candidate) => candidate.textContent?.trim() === text
	);
	const target = label?.getAttribute("for");
	const control =
		(label?.id
			? scope.querySelector<HTMLElement>(`[aria-labelledby~="${label.id}"]`)
			: null) ?? (target ? document.getElementById(target) : null);
	if (!control) {
		throw new Error(`No control is labelled ${text}`);
	}
	return control;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await settle();
}

test("the page is headed by the provider's name, its status and one line that says what it is", async () => {
	const host = await mount(CLAUDE);
	const page = one(host, "[data-provider-page]");
	expect(page.getAttribute("data-provider-page")).toBe("Claude Pro/Max");
	const title = one(page, "h3");
	expect(title.textContent).toBe("Claude Pro/Max");
	// The title takes the focus, so the page is announced when it opens.
	expect(document.activeElement).toBe(title);
	// The api type, then the same kind and summary the list row showed.
	expect(one(page, "[data-provider-page-meta]").textContent).toBe(
		"anthropic-messages · Subscription · Accounts: 2"
	);
	// One status beside the title: an account must sign in again.
	const head = title.parentElement as HTMLElement;
	expect(head.textContent).toBe("Claude Pro/MaxNeeds sign-in");

	await click(one(page, 'button[aria-label="Back to AI providers"]'));
	expect(seen.onBack).toHaveLength(1);
});

test("each kind of provider gets its sections under the same headings, in the one order", async () => {
	expect(outline(await mount(CLAUDE))).toEqual([
		"Connected accounts",
		"Routing",
		"Models",
	]);
	// A sign-in provider without an account yet: the same place says "Sign in".
	const signedOut = provider("chatgpt-plan", "ChatGPT", {
		authKind: "subscription",
		supportsOAuth: true,
	});
	expect(outline(await mount(signedOut))).toEqual([
		"Sign in",
		"Routing",
		"Models",
	]);
	expect(outline(await mount(OPENAI))).toEqual([
		"Connected accounts",
		"API key",
		"Routing",
		"Models",
		"Danger zone",
	]);
	// Nothing stored yet: there is nothing to remove, so no danger zone.
	expect(outline(await mount(GROQ))).toEqual(["API key", "Routing", "Models"]);
	expect(outline(await mount(RYU))).toEqual(["Routing", "Models"]);
});

test("the routing switch is named by its label, shows the route in use and saves a change", async () => {
	const host = await mount(OPENAI);
	const routing = labelled(section(host, "routing"), "Route through Gateway");
	expect(routing.getAttribute("role")).toBe("switch");
	// A click on the words works the switch too: the label is tied to it.
	expect(one(section(host, "routing"), "label").getAttribute("for")).toBe(
		"routing-openai"
	);
	expect(routing.getAttribute("aria-checked")).toBe("true");

	await click(routing);
	expect(seen.onConfigure).toEqual([
		[{ provider: "openai", routing: "direct" }],
	]);
	expect(routing.getAttribute("aria-checked")).toBe("false");
	expect(successToast.mock.calls.map(([toast]) => toast.title)).toEqual([
		"OpenAI egress is direct",
	]);

	await click(routing);
	expect(seen.onConfigure?.[1]).toEqual([
		{ provider: "openai", routing: "gateway" },
	]);
	expect(routing.getAttribute("aria-checked")).toBe("true");
	expect(successToast.mock.calls.at(-1)?.[0].title).toBe(
		"OpenAI routes through the Gateway"
	);
});

test("a routing change Core refuses goes back to what it was and says why", async () => {
	refuse = "routing is fixed by your organization";
	const host = await mount(CLAUDE);
	const routing = labelled(section(host, "routing"), "Route through Gateway");
	// This provider goes direct today.
	expect(routing.getAttribute("aria-checked")).toBe("false");
	await click(routing);
	expect(seen.onConfigure).toEqual([
		[{ provider: "claude-pro-max", routing: "gateway" }],
	]);
	await until(() => errorToast.mock.calls.length === 1, "refusal never shown");
	expect(errorToast.mock.calls[0]?.[0]).toEqual({
		description: "routing is fixed by your organization",
		title: "Could not update routing",
	});
	expect(routing.getAttribute("aria-checked")).toBe("false");
	expect(successToast.mock.calls).toHaveLength(0);
});

test("a provider whose route is fixed shows the switch but does not let it move", async () => {
	const host = await mount(RYU);
	const routing = labelled(section(host, "routing"), "Route through Gateway");
	expect(routing.getAttribute("aria-checked")).toBe("true");
	expect(routing.matches('[aria-disabled="true"], [data-disabled]')).toBe(true);
	await click(routing);
	expect(seen.onConfigure).toBeUndefined();
	expect(routing.getAttribute("aria-checked")).toBe("true");
});

test("the page looks up the live models as it opens, and every model is a named switch", async () => {
	const live = { ...OPENAI, supportsDiscovery: true } as PiProvider;
	const host = await mount(live);
	// The old card asked only when it was unfolded. A page is open at once.
	await until(() => seen.discover?.length === 1, "models never looked up");
	expect(seen.discover).toEqual([[{ provider: "openai" }]]);
	const models = section(host, "models");
	await until(
		() => models.querySelector('[aria-label*="GPT 5.2 mini"]') !== null,
		"discovered model never listed"
	);
	const names = Array.from(
		models.querySelectorAll<HTMLElement>('[role="switch"]')
	).map((control) => control.getAttribute("aria-label"));
	expect(names).toEqual([
		"Enable all OpenAI models",
		"Enable OpenAI model gpt-5.2",
		"Enable OpenAI model GPT 5.2 mini",
	]);

	await click(one(models, '[aria-label="Enable OpenAI model GPT 5.2 mini"]'));
	expect(seen.onToggleModel).toEqual([["openai", "gpt-5.2-mini", false]]);
	// One look per visit: working the page does not ask again.
	expect(seen.discover).toHaveLength(1);
});

test("a provider without a model list is not asked for one", async () => {
	const host = await mount(OPENAI);
	await settle(50);
	expect(seen.discover).toBeUndefined();
	// What Core suggests is still offered.
	expect(
		one(section(host, "models"), '[aria-label="Enable OpenAI model gpt-5.2"]')
	).not.toBeNull();
	expect(section(host, "models").textContent).not.toContain("Discover models");
});

test("the key field is named, never shows the stored key, and Check reports the connection", async () => {
	const live = { ...OPENAI, supportsDiscovery: true } as PiProvider;
	const host = await mount(live);
	// The provider in use carries the Active status beside its name.
	const head = one(host, "h3").parentElement as HTMLElement;
	expect(one(head, '[role="img"]').getAttribute("aria-label")).toBe("Active");
	const keys = section(host, "api-key");
	const field = labelled(keys, "API key") as HTMLInputElement;
	expect(field.id).toBe("key-openai");
	expect(field.type).toBe("password");
	expect(field.value).toBe("");
	expect(field.placeholder).toContain("leave blank to keep");
	expect(field.getAttribute("autocomplete")).toBe("off");
	// Nothing typed: there is nothing to save.
	expect(button(keys, "Save").disabled).toBe(true);

	await click(button(keys, "Check"));
	expect(seen.check).toEqual([[{ apiKey: undefined, provider: "openai" }]]);
	await until(
		() => keys.textContent?.includes("OK · 120ms · 4 models") === true,
		"check result never shown"
	);
	// The page holds one Remove, in the danger zone, not beside the key too.
	expect(keys.textContent).not.toContain("Remove");
});

test("the danger zone removes the stored credential, and says so when Core refuses", async () => {
	const host = await mount(OPENAI);
	const danger = section(host, "danger");
	expect(danger.textContent).toContain("Credential");
	await click(button(danger, "Remove"));
	expect(seen.onRemove).toEqual([["openai"]]);
	expect(successToast.mock.calls.map(([toast]) => toast.title)).toEqual([
		"OpenAI credential removed",
	]);

	refuse = "the credential is in use";
	await click(button(danger, "Remove"));
	await until(() => errorToast.mock.calls.length === 1, "refusal never shown");
	expect(errorToast.mock.calls[0]?.[0]).toEqual({
		description: "the credential is in use",
		title: "Could not remove credential",
	});
	// The button is ready again after the refusal.
	expect(button(danger, "Remove").disabled).toBe(false);
});

test("the pools block sits under the accounts and Manage asks the host for the pools page", async () => {
	const host = await mount(CLAUDE);
	const accounts = section(host, "accounts");
	await until(
		() => accounts.querySelector("[data-provider-account-pools]") !== null,
		"pools block never shown"
	);
	const block = one(accounts, "[data-provider-account-pools]");
	expect(one(block, '[data-pool-account="work"]').textContent).toContain(
		"Mythos"
	);
	// The accounts themselves come first, their pools after them.
	const text = accounts.textContent ?? "";
	expect(text.indexOf("work@example.com")).toBeGreaterThan(-1);
	expect(text.indexOf("work@example.com")).toBeLessThan(
		text.indexOf("Account pools")
	);

	await click(button(block, "Manage"));
	expect(seen.onManagePools).toHaveLength(1);
	expect(seen.onBack).toBeUndefined();
});

test("Ryu without a plan or a balance offers prepaid credits and opens the credits page", async () => {
	const host = await mount(RYU, { funding: UNPAID });
	expect(one(host, "[data-provider-page-meta]").textContent).toBe(
		"openai-completions · Add prepaid credits"
	);
	const page = one(host, "[data-provider-page]");
	expect(page.textContent).toContain(
		"Use Ryu-managed models with prepaid credits"
	);
	expect(page.textContent).toContain(
		"Pay as you go. Usage pauses when the balance is empty."
	);
	// The offer is above the sections, not inside one.
	const offer = button(page, "Add prepaid credits");
	expect(offer.closest("[data-provider-page-section]")).toBeNull();
	expect(
		offer.compareDocumentPosition(section(host, "routing")) &
			Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();

	useGatewayDialog.setState({ open: true });
	await click(offer);
	expect(useGatewayDialog.getState().open).toBe(false);
	expect(useSettingsDialog.getState().open).toBe(true);
	expect(useSettingsDialog.getState().section).toBe("credits");
});

test("with a prepaid balance, or on a donated pool, there is no credits offer", async () => {
	const funded = await mount(RYU, {
		funding: { hasPrepaidBalance: true, managedInference: false },
		hasPrepaidManagedBalance: true,
	});
	expect(funded.textContent).not.toContain("prepaid credits");

	const donated = await mount(
		{ ...RYU, creditPool: "cloudflare", id: "workers", label: "Workers AI" },
		{ funding: UNPAID }
	);
	expect(donated.textContent).not.toContain("prepaid credits");
});
