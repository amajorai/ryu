// The provider list mounted alone, with the states its host hands it: nothing
// connected, a default provider, a node without pools or without gateway keys,
// a search with and without a match. No network: the list is props in, rows
// and two callbacks out.

import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";
import { act, type ReactNode, useState } from "react";
import type { Root } from "react-dom/client";
import type { PiConfig, PiProvider } from "@/src/lib/api/pi-config.ts";
import type {
	ManagedFunding,
	ProviderSummary,
} from "./provider-pages-model.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const {
	EXTRA_ROWS,
	KIND_LABELS,
	LINK_ROWS,
	ProviderList,
	ProviderRowEnd,
	providerRowLine,
	summaryText,
} = await import("./ProviderList.tsx");

/** The catalog's English, as the list shows it with no language pack loaded. */
const tl: LiteralMessage = (message, values) =>
	message.replace(/\{(\w+)\}/g, (_, name: string) =>
		String((values as Record<string, unknown> | undefined)?.[name])
	);

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
		supportsOAuth: false,
		...extra,
	} as PiProvider;
}

const RYU = provider("gateway", "Ryu", {
	authKind: "none",
	configured: true,
	creditPool: "openrouter",
	managed: true,
});
const CLAUDE = provider("claude-pro-max", "Claude Pro/Max", {
	accounts: [
		account("work", "work@example.com", { active: true }),
		account("home", "home@example.com", { needsReauth: true }),
	],
	api: "anthropic-messages",
	authKind: "subscription",
	configured: true,
	supportsOAuth: true,
});
const OPENAI = provider("openai", "OpenAI", {
	accounts: [account("key-1", "Team key", { kind: "api_key" })],
	active: true,
	configured: true,
	suggestedModels: ["gpt-5.2"],
});
const GROQ = provider("groq", "Groq");
const OLLAMA = provider("ollama", "Ollama", { authKind: "none" });
const LAB = provider("lab", "Lab endpoint", { configured: true, custom: true });

const PAID: ManagedFunding = {
	hasPrepaidBalance: false,
	managedInference: true,
};
const UNPAID: ManagedFunding = {
	hasPrepaidBalance: false,
	managedInference: false,
};
const CONFIG: PiConfig = {
	configDir: "/tmp/pi",
	model: "gpt-5.2",
	provider: "openai",
	routing: "gateway",
	thinkingLevel: null,
};

interface Opened {
	page: string;
	rowId: string;
}
const roots: Root[] = [];
let opened: Opened[] = [];
let sections: string[] = [];
let queries: string[] = [];

interface ListOptions {
	activeConfig?: PiConfig | null;
	funding?: ManagedFunding;
	gatewayKeys?: boolean;
	intro?: ReactNode;
	linked?: boolean;
	poolCount?: number | null;
	poolsSupported?: boolean;
	providers?: PiProvider[];
	query?: string;
}

/** The list with the search text held the way its host holds it. */
function Harness({
	activeConfig = CONFIG,
	funding = PAID,
	gatewayKeys = true,
	intro,
	linked = true,
	poolCount = 2,
	poolsSupported = true,
	providers = [RYU, CLAUDE, OPENAI, GROQ],
	query: initialQuery = "",
}: ListOptions) {
	const [query, setQuery] = useState(initialQuery);
	return (
		<ProviderList
			activeConfig={activeConfig}
			funding={funding}
			gatewayKeys={gatewayKeys}
			intro={intro}
			onOpen={(page, rowId) => opened.push({ page, rowId })}
			onOpenSection={linked ? (section) => sections.push(section) : undefined}
			onQueryChange={(next) => {
				queries.push(next);
				setQuery(next);
			}}
			poolCount={poolCount}
			poolsSupported={poolsSupported}
			providers={providers}
			query={query}
		/>
	);
}

async function mount(options: ListOptions = {}): Promise<HTMLElement> {
	opened = [];
	sections = [];
	queries = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<Harness {...options} />));
	return host;
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

function one<T extends HTMLElement = HTMLElement>(
	host: HTMLElement,
	selector: string
): T {
	const element = host.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}: ${host.textContent}`);
	}
	return element;
}

function row(host: HTMLElement, rowId: string): HTMLButtonElement {
	return one<HTMLButtonElement>(host, `[data-provider-page-row="${rowId}"]`);
}

/** The whole row of a button: its status and chevron sit beside the button. */
function item(host: HTMLElement, rowId: string): HTMLElement {
	const found = row(host, rowId).closest<HTMLElement>('[data-slot="item"]');
	if (!found) {
		throw new Error(`Row ${rowId} is not inside an item`);
	}
	return found;
}

/** What a screen reader says for an element: its text without hidden parts. */
function spoken(element: HTMLElement): string {
	const copy = element.cloneNode(true) as HTMLElement;
	for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
		hidden.remove();
	}
	return copy.textContent ?? "";
}

function rowIds(host: HTMLElement): string[] {
	return Array.from(
		host.querySelectorAll<HTMLElement>("[data-provider-page-row]")
	).map((element) => element.getAttribute("data-provider-page-row") ?? "");
}

function headings(host: HTMLElement): string[] {
	return Array.from(host.querySelectorAll("h3")).map(
		(heading) => heading.textContent ?? ""
	);
}

async function type(host: HTMLElement, value: string) {
	const field = one<HTMLInputElement>(host, 'input[type="search"]');
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

test("with nothing connected the list says so in one line and still offers every provider", async () => {
	const host = await mount({
		activeConfig: null,
		providers: [GROQ, provider("mistral", "Mistral")],
	});
	// No provider is in use, so there is no default row to open.
	expect(host.querySelector('[data-provider-page-row="default"]')).toBeNull();
	const empty = one(host, "[data-provider-list-empty]");
	expect(empty.textContent).toBe("No providers connected yet.");
	// A status, so a screen reader hears it without a focus move.
	expect(empty.getAttribute("role")).toBe("status");
	// The three groups keep their headings and their order.
	expect(headings(host)).toEqual(["Connected", "Other", "More"]);
	expect(rowIds(host).slice(0, 3)).toEqual([
		"provider:groq",
		"provider:mistral",
		"custom-provider",
	]);
	expect(spoken(row(host, "provider:groq"))).toBe(
		"GroqAPI key · Not connected"
	);
});

test("the default row names the provider in use and its model, and opens that provider", async () => {
	const host = await mount();
	const first = row(host, "default");
	expect(rowIds(host)[0]).toBe("default");
	expect(spoken(first)).toBe("Default providergpt-5.2");
	// The provider's name is the value at the end of the row.
	expect(item(host, "default").textContent).toContain("OpenAI");
	await act(async () => first.click());
	// It opens the provider's page, and "back" returns to the default row.
	expect(opened).toEqual([{ page: "provider:openai", rowId: "default" }]);
});

test("without an active provider the default row falls back to the saved config", async () => {
	const host = await mount({
		activeConfig: { ...CONFIG, model: null, provider: "claude-pro-max" },
		providers: [RYU, CLAUDE, GROQ],
	});
	// No model chosen yet: the row has no second line.
	expect(spoken(row(host, "default"))).toBe("Default provider");
	expect(item(host, "default").textContent).toContain("Claude Pro/Max");
	await act(async () => row(host, "default").click());
	expect(opened).toEqual([
		{ page: "provider:claude-pro-max", rowId: "default" },
	]);
});

test("every provider is one row: kind and summary in the name, at most one status at the end", async () => {
	const host = await mount({ providers: [RYU, CLAUDE, OPENAI, GROQ, OLLAMA] });
	expect(spoken(row(host, "provider:gateway"))).toBe("RyuRyu managed");
	expect(spoken(row(host, "provider:claude-pro-max"))).toBe(
		"Claude Pro/MaxSubscription · Accounts: 2"
	);
	expect(spoken(row(host, "provider:openai"))).toBe("OpenAIAPI key · Team key");
	// A provider without a bundled logo shows its initial as the mark. The
	// initial is for the eye only: it is not the first word of the row's name.
	const mark = one(row(host, "provider:gateway"), '[aria-hidden="true"]');
	expect(mark.textContent).toBe("R");
	expect(row(host, "provider:gateway").textContent).toBe("RRyuRyu managed");
	// An engine on this computer is connected without a credential.
	expect(spoken(row(host, "provider:ollama"))).toBe("OllamaLocal · Ready");
	expect(rowIds(host).indexOf("provider:ollama")).toBeLessThan(
		rowIds(host).indexOf("provider:groq")
	);

	// An account that must sign in again outranks "in use".
	const waiting = item(host, "provider:claude-pro-max");
	expect(waiting.textContent).toContain("Needs sign-in");
	expect(waiting.querySelector('[role="img"]')).toBeNull();
	// The provider in use carries the status glyph with its word as the name.
	const active = one(item(host, "provider:openai"), '[role="img"]');
	expect(active.getAttribute("aria-label")).toBe("Active");
	// Everything else ends in the chevron alone.
	const quiet = item(host, "provider:groq");
	expect(quiet.querySelector('[role="img"]')).toBeNull();
	expect(spoken(quiet)).toBe("GroqAPI key · Not connected");

	await act(async () => row(host, "provider:groq").click());
	expect(opened).toEqual([{ page: "provider:groq", rowId: "provider:groq" }]);
});

test("a managed row says what the org pays with", async () => {
	const donated = provider("workers", "Workers AI", {
		authKind: "none",
		configured: true,
		creditPool: "cloudflare",
		managed: true,
	});
	const host = await mount({ funding: UNPAID, providers: [RYU, donated] });
	// No plan and no balance: the row says what to do, not "Ryu managed".
	expect(spoken(row(host, "provider:gateway"))).toBe("RyuAdd prepaid credits");
	// Donated supply needs neither.
	expect(spoken(row(host, "provider:workers"))).toBe(
		"Workers AIOrg credit pool"
	);
});

test("rows the node or the host cannot offer are left out", async () => {
	const host = await mount({
		gatewayKeys: false,
		linked: false,
		poolCount: null,
		poolsSupported: false,
	});
	expect(rowIds(host).slice(-4)).toEqual([
		"custom-provider",
		"agent-models",
		"model-parameters",
		"capabilities",
	]);
});

test("the pools row shows the number of pools once it is known", async () => {
	const unknown = await mount({ poolCount: null });
	expect(item(unknown, "account-pools").textContent).toBe("Account pools");
	const none = await mount({ poolCount: 0 });
	expect(item(none, "account-pools").textContent).toBe("Account pools0");
	const some = await mount({ poolCount: 3 });
	expect(item(some, "account-pools").textContent).toBe("Account pools3");
	// The number is beside the button, so the button's name stays the page.
	expect(spoken(row(some, "account-pools"))).toBe("Account pools");
});

test("a shared page opens by its own id and a linked pane goes to the host instead", async () => {
	const host = await mount();
	await act(async () => row(host, "account-pools").click());
	await act(async () => row(host, "custom-provider").click());
	expect(opened).toEqual([
		{ page: "account-pools", rowId: "account-pools" },
		{ page: "custom-provider", rowId: "custom-provider" },
	]);
	await act(async () => row(host, "section:routing").click());
	expect(sections).toEqual(["routing"]);
	expect(opened).toHaveLength(2);
	// Every shared row is named by its title.
	expect(spoken(row(host, "capabilities"))).toBe(EXTRA_ROWS.capabilities.title);
	expect(spoken(row(host, "section:keys"))).toBe(LINK_ROWS.keys.title);
});

test("the search field is named, sits beside the Connected heading and reports what is typed", async () => {
	const host = await mount({ intro: <p data-list-intro="">billing note</p> });
	const field = one<HTMLInputElement>(host, 'input[type="search"]');
	expect(field.getAttribute("aria-label")).toBe("Search providers and models…");
	expect(field.placeholder).toBe("Search providers and models…");
	expect(field.parentElement?.querySelector("h3")?.textContent).toBe(
		"Connected"
	);
	// The host's note stays above everything else.
	expect(one(host, "[data-provider-list]").firstElementChild).toBe(
		one(host, "[data-list-intro]")
	);

	await type(host, "claude");
	expect(queries).toEqual(["claude"]);
	expect(field.value).toBe("claude");
	expect(rowIds(host)).toEqual(["provider:claude-pro-max"]);
	// A search is about the rows: the default row and empty groups step aside.
	expect(headings(host)).toEqual(["Connected"]);
});

test("a search that matches only unconnected rows shows no empty line", async () => {
	const host = await mount({ query: "groq" });
	expect(rowIds(host)).toEqual(["provider:groq"]);
	expect(headings(host)).toEqual(["Connected", "Other"]);
	expect(host.querySelector("[data-provider-list-empty]")).toBeNull();
});

test("a search finds a shared page by what it is for, and says so when nothing matches", async () => {
	const host = await mount({ query: "temperature" });
	expect(rowIds(host)).toEqual(["model-parameters"]);
	expect(host.querySelector("[data-provider-list-empty]")).toBeNull();

	await type(host, "fallback");
	expect(rowIds(host)).toEqual(["section:routing"]);

	await type(host, "no such thing");
	expect(rowIds(host)).toEqual([]);
	const empty = one(host, "[data-provider-list-empty]");
	expect(empty.textContent).toBe("Nothing matches your search.");
	expect(empty.getAttribute("role")).toBe("status");
	expect(headings(host)).toEqual(["Connected"]);
});

test("a search for a pane the host cannot open finds nothing", async () => {
	const host = await mount({ linked: false, query: "fallback" });
	expect(rowIds(host)).toEqual([]);
	expect(one(host, "[data-provider-list-empty]").textContent).toBe(
		"Nothing matches your search."
	);
});

test("summaryText turns every summary into one short line", () => {
	const cases: [ProviderSummary, string][] = [
		[{ id: "managed", needsCredits: false, poolBacked: false }, "Ryu managed"],
		[
			{ id: "managed", needsCredits: true, poolBacked: false },
			"Add prepaid credits",
		],
		[
			{ id: "managed", needsCredits: true, poolBacked: true },
			"Org credit pool",
		],
		[{ id: "not-connected" }, "Not connected"],
		[{ id: "accounts", count: 3, waiting: 1 }, "Accounts: 3"],
		[
			{ id: "account", label: "work@example.com", waiting: 0 },
			"work@example.com",
		],
		[{ id: "connected" }, "Connected"],
		[{ id: "ready" }, "Ready"],
		[{ id: "configured" }, "Configured"],
	];
	for (const [summary, text] of cases) {
		expect(summaryText(summary, tl)).toBe(text);
	}
});

test("providerRowLine leads with the kind, except on a managed row", () => {
	expect(providerRowLine(RYU, PAID, tl)).toBe("Ryu managed");
	expect(providerRowLine(RYU, UNPAID, tl)).toBe("Add prepaid credits");
	expect(providerRowLine(CLAUDE, PAID, tl)).toBe("Subscription · Accounts: 2");
	expect(providerRowLine(OPENAI, PAID, tl)).toBe("API key · Team key");
	expect(providerRowLine(OLLAMA, PAID, tl)).toBe("Local · Ready");
	expect(providerRowLine(LAB, PAID, tl)).toBe("Custom · Configured");
	// One label per kind, none empty.
	expect(Object.keys(KIND_LABELS).sort()).toEqual([
		"api-key",
		"custom",
		"local",
		"managed",
		"subscription",
	]);
	expect(Object.values(KIND_LABELS).every((label) => label.length > 0)).toBe(
		true
	);
});

test("ProviderRowEnd is one status or nothing", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<>
				<span data-end="waiting">
					<ProviderRowEnd provider={CLAUDE} />
				</span>
				<span data-end="active">
					<ProviderRowEnd provider={OPENAI} />
				</span>
				<span data-end="reconnect">
					<ProviderRowEnd
						provider={provider("chatgpt-plan", "ChatGPT", {
							active: true,
							connectionState: "reconnect-required",
						})}
					/>
				</span>
				<span data-end="quiet">
					<ProviderRowEnd provider={GROQ} />
				</span>
			</>
		)
	);
	expect(one(host, '[data-end="waiting"]').textContent).toBe("Needs sign-in");
	expect(
		one(host, '[data-end="active"] [role="img"]').getAttribute("aria-label")
	).toBe("Active");
	// A provider that must reconnect says so even while it is the one in use.
	expect(one(host, '[data-end="reconnect"]').textContent).toBe("Needs sign-in");
	expect(one(host, '[data-end="quiet"]').childNodes).toHaveLength(0);
});
