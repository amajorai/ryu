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
import { CORE_LOCAL_ENGINES } from "@/src/lib/api/local-engines.ts";
import {
	blur,
	byLabel,
	choose,
	click,
	fill,
	isDisabled,
	isOn,
	normalized,
	pageText,
	settle,
	shownValue,
} from "./general-agents-network.test-support.ts";

// Control-level coverage for the Memory tab's "Snippets per reply" limit and
// for the shared `SideModelPicker` as the tab's conversation summarizer uses
// it. `MemoryTab` is mounted unchanged with its production preference,
// retrieval, memory and Pi catalog clients. A Core-shaped native HTTP fixture
// owns `/api/preferences/:key` (GET 404 when unset, PUT `{ value }` stored
// verbatim, node bearer and member JWT required), `/api/memory/settings`,
// `/api/spaces`, `/api/agents` and `/api/pi-config/catalog`, so a remount reads
// back exactly what the tab wrote. The app shell's EntitlementProvider (which
// the model picker reads) mirrors its verdict through the same preference
// route.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
window.fetch = nativeFetch;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

const NODE_TOKEN = "memory-coverage-node-token";
const USER_JWT = "memory-coverage-user-jwt";
const PREF = "/api/preferences/";
const UNRELATED_PREF = "voice-wake-word";

interface Exchange {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

let prefs = new Map<string, string>();
let refusals = new Map<string, number>();
const exchanges: Exchange[] = [];
const unexpected: string[] = [];

function seedPrefs(extra: Record<string, string> = {}) {
	prefs = new Map(
		Object.entries({
			"auto-recall-enabled": "true",
			"auto-recall-top-k": "80",
			"context.auto-compact": "true",
			"context.max-tokens": "8192",
			[UNRELATED_PREF]: "hey ryu",
			...extra,
		})
	);
}

const CATALOG = {
	agentModelOverrides: {},
	apiTypes: ["openai-completions"],
	providers: [
		{
			active: true,
			api: "openai-completions",
			authEnv: "",
			authKind: "none",
			configured: true,
			custom: false,
			id: "local",
			label: "Local",
			modelOverrides: {},
			routing: "direct",
			suggestedModels: ["qwen-local", "gemma-local"],
			supportsDiscovery: false,
		},
	],
	thinkingLevels: ["low", "medium", "high"],
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;
		const raw = request.method === "PUT" ? await request.text() : "";
		const call: Exchange = {
			body: raw ? JSON.parse(raw) : null,
			method: request.method,
			path,
			status: 200,
		};
		exchanges.push(call);
		if (
			request.headers.get("authorization") !== `Bearer ${NODE_TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`${request.method} ${path} without node credentials`);
			call.status = 401;
			return NativeResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		if (path.startsWith(PREF)) {
			const key = decodeURIComponent(path.slice(PREF.length));
			if (request.method === "GET") {
				const value = prefs.get(key);
				if (value === undefined) {
					call.status = 404;
					return NativeResponse.json({ error: "unset" }, { status: 404 });
				}
				return NativeResponse.json({ key, value });
			}
			if (request.method === "PUT") {
				const pending = refusals.get(key) ?? 0;
				if (pending > 0) {
					refusals.set(key, pending - 1);
					call.status = 503;
					return NativeResponse.json({ error: "busy" }, { status: 503 });
				}
				const body = call.body as { value?: unknown } | null;
				if (
					!body ||
					Object.keys(body).join() !== "value" ||
					typeof body.value !== "string"
				) {
					unexpected.push(`Invalid preference body ${raw}`);
					call.status = 400;
					return NativeResponse.json({ error: "bad body" }, { status: 400 });
				}
				prefs.set(key, body.value);
				return NativeResponse.json({ key, value: body.value });
			}
		}
		if (request.method !== "GET") {
			unexpected.push(`Undeclared ${request.method} ${path}`);
			call.status = 405;
			return NativeResponse.json({ error: "undeclared" }, { status: 405 });
		}
		switch (path) {
			case "/api/memory/settings":
				return NativeResponse.json({ include_sensitive_topics: false });
			case "/api/spaces":
				return NativeResponse.json({ spaces: [] });
			case "/api/agents":
				return NativeResponse.json({ agents: [] });
			case "/api/pi-config/catalog":
				return NativeResponse.json(CATALOG);
			case "/api/engines":
				return NativeResponse.json({ engines: [] });
			case "/api/engine/active":
				return NativeResponse.json({
					active: null,
					available: [],
					running: false,
				});
			default:
				unexpected.push(`Undeclared GET ${path}`);
				call.status = 404;
				return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		}
	},
});

const ownedFetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (new URL(url).origin !== server.url.origin) {
			unexpected.push(`Unowned origin ${url}`);
			return Promise.reject(new Error(`Unowned origin ${url}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = ownedFetch;
window.fetch = ownedFetch;

const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { MemoryTab } = await import("./MemoryTab.tsx");

const initialNodeState = useNodeStore.getState();
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	seedPrefs();
	refusals = new Map();
	exchanges.length = 0;
	unexpected.length = 0;
	localStorage.clear();
	localStorage.setItem("memory-coverage-unrelated", "kept");
	await act(async () => {
		queryClient.clear();
		sileo.clear();
	});
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "memory-coverage",
		nodes: [
			{
				name: "memory-coverage",
				token: NODE_TOKEN,
				url: server.url.origin,
				userJwt: USER_JWT,
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
		sileo.clear();
	});
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("memory-coverage-unrelated")).toBe("kept");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave the unrelated node preference untouched.
	expect(prefs.get(UNRELATED_PREF)).toBe("hey ryu");
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects unauthenticated, undeclared or off-fixture requests.
	expect(unexpected).toEqual([]);
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

function prefReads(key: string) {
	return exchanges.filter(
		(call) => call.method === "GET" && call.path === `${PREF}${key}`
	);
}

function writes(key: string) {
	return exchanges
		.filter((call) => call.method === "PUT" && call.path === `${PREF}${key}`)
		.map((call) => ({ body: call.body, status: call.status }));
}

async function mount({ summarizer = true } = {}) {
	const before = exchanges.length;
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<MemoryTab />
					<Toaster position="bottom-right" />
				</EntitlementProvider>
			</QueryClientProvider>
		)
	);
	await settle(
		() =>
			[
				"auto-recall-top-k",
				"context.compact-model",
				"context.compact-effort",
			].every((key) =>
				exchanges
					.slice(before)
					.some(
						(call) =>
							call.method === "GET" &&
							call.path === `${PREF}${key}` &&
							call.status > 0
					)
			) && snippets().value !== "",
		"Memory tab reads"
	);
	if (!summarizer) {
		// The summarizer picker only renders once a global budget is set.
		return;
	}
	await settle(
		() => container.querySelector('[aria-label="Model"]') !== null,
		"summarizer picker"
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

async function remount() {
	await unmount();
	await mount();
}

function snippets(): HTMLInputElement {
	return byLabel<HTMLInputElement>("Snippets recalled per reply", container);
}

async function commitSnippets(value: string) {
	await fill(snippets(), value);
	await blur(snippets());
}

function effortSelect(): HTMLElement {
	const label = [...container.querySelectorAll("label")].find(
		(candidate) => normalized(candidate) === "Thinking / effort level"
	);
	const combo =
		label?.parentElement?.querySelector<HTMLElement>('[role="combobox"]');
	if (!combo) {
		throw new Error("Missing effort select");
	}
	return combo;
}

function modelTrigger(): HTMLButtonElement {
	return byLabel<HTMLButtonElement>("Model", container);
}

function pickerItems(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
}

/** Select the picker row whose text is `text` (or starts with it, for a
 * submenu row that also shows its current value). */
async function pickerSelect(text: string, prefix = false) {
	const matches = (item: HTMLElement) =>
		prefix ? normalized(item).startsWith(text) : normalized(item) === text;
	await settle(
		() => pickerItems().some(matches),
		`picker row ${text}`,
		() =>
			pickerItems()
				.map((item) => normalized(item))
				.join(" | ")
	);
	await click(pickerItems().find(matches)!);
}

async function pickerClosed() {
	await settle(
		() => document.querySelector('[aria-label="Custom model id"]') === null,
		"picker closed"
	);
}

test("Snippets per reply shows an out-of-range stored limit as-is, writes nothing on an unchanged blur or non-number, clamps edits to 1–50, and a remount reads the saved limit", async () => {
	await mount();
	expect(snippets().value).toBe("80");
	expect(prefReads("auto-recall-top-k")).toHaveLength(1);
	expect(pageText()).toContain(
		"This control writes 1–50; a larger number set outside the app is shown as-is and left alone until you change it."
	);

	await act(async () => snippets().focus());
	await blur(snippets());
	await commitSnippets("80");
	await commitSnippets("lots");
	expect(snippets().value).toBe("80");
	expect(writes("auto-recall-top-k")).toEqual([]);
	expect(prefs.get("auto-recall-top-k")).toBe("80");

	await commitSnippets("0");
	await settle(() => writes("auto-recall-top-k").length === 1, "floor write");
	expect(snippets().value).toBe("1");
	await commitSnippets(" 12 ");
	await settle(() => writes("auto-recall-top-k").length === 2, "edit write");
	await commitSnippets("500");
	await settle(() => writes("auto-recall-top-k").length === 3, "ceiling write");
	expect(snippets().value).toBe("50");
	expect(writes("auto-recall-top-k")).toEqual([
		{ body: { value: "1" }, status: 200 },
		{ body: { value: "12" }, status: 200 },
		{ body: { value: "50" }, status: 200 },
	]);

	await remount();
	expect(snippets().value).toBe("50");
	expect(prefs.get("auto-recall-top-k")).toBe("50");
});

test("a refused Snippets save restores the stored limit and explains it; turning auto-recall off disables the limit without writing it", async () => {
	seedPrefs({ "auto-recall-top-k": "6" });
	await mount();
	expect(snippets().value).toBe("6");

	refusals.set("auto-recall-top-k", 1);
	await commitSnippets("9");
	await settle(
		() => pageText().includes("Couldn't save the recall limit"),
		"refusal toast"
	);
	await settle(() => snippets().value === "6", "limit restored");
	expect(prefs.get("auto-recall-top-k")).toBe("6");

	await commitSnippets("9");
	await settle(() => prefs.get("auto-recall-top-k") === "9", "retry saved");
	expect(writes("auto-recall-top-k")).toEqual([
		{ body: { value: "9" }, status: 503 },
		{ body: { value: "9" }, status: 200 },
	]);

	const recall = byLabel("Automatically recall relevant context", container);
	expect(isOn(recall)).toBe(true);
	expect(snippets().disabled).toBe(false);
	await click(recall);
	await settle(
		() => prefs.get("auto-recall-enabled") === "false",
		"auto-recall off"
	);
	expect(isDisabled(snippets())).toBe(true);
	expect(snippets().value).toBe("9");
	expect(writes("auto-recall-top-k")).toHaveLength(2);

	await remount();
	expect(
		isOn(byLabel("Automatically recall relevant context", container))
	).toBe(false);
	expect(snippets().disabled).toBe(true);
	expect(snippets().value).toBe("9");
});

test("the summarizer's SideModelPicker writes a catalog or custom model id and an effort level, Provider default clears the effort, a refusal restores the previous pick, and a remount reads it back", async () => {
	await mount();
	expect(normalized(modelTrigger())).toContain("Use default model");
	expect(shownValue(effortSelect())).toBe("Provider default");

	const offered = await choose(effortSelect(), "high");
	expect(offered).toEqual(["Provider default", "low", "medium", "high"]);
	await settle(
		() => prefs.get("context.compact-effort") === "high",
		"effort saved"
	);
	expect(writes("context.compact-effort")).toEqual([
		{ body: { value: "high" }, status: 200 },
	]);
	expect(writes("context.compact-model")).toEqual([
		{ body: { value: "" }, status: 200 },
	]);

	await click(modelTrigger());
	await pickerSelect("Local");
	await pickerSelect("Model", true);
	await pickerSelect("gemma-local");
	await pickerClosed();
	await settle(
		() => prefs.get("context.compact-model") === "gemma-local",
		"catalog model saved"
	);
	expect(normalized(modelTrigger())).toContain("gemma-local");
	expect(prefs.get("context.compact-effort")).toBe("high");

	await click(modelTrigger());
	await settle(
		() => document.querySelector('[aria-label="Custom model id"]') !== null,
		"custom model row"
	);
	const custom = document.querySelector<HTMLInputElement>(
		'[aria-label="Custom model id"]'
	)!;
	await fill(custom, "  summary-local-model  ");
	await click(byLabel("Use this model"));
	await pickerClosed();
	await settle(
		() => prefs.get("context.compact-model") === "summary-local-model",
		"custom model saved"
	);
	expect(normalized(modelTrigger())).toContain("summary-local-model");

	refusals.set("context.compact-effort", 1);
	await choose(effortSelect(), "low");
	await settle(
		() => pageText().includes("Couldn't save the summarizer model"),
		"summarizer refusal"
	);
	await settle(() => shownValue(effortSelect()) === "high", "effort restored");
	expect(prefs.get("context.compact-effort")).toBe("high");

	await choose(effortSelect(), "Provider default");
	await settle(
		() => prefs.get("context.compact-effort") === "",
		"effort cleared"
	);
	expect(writes("context.compact-effort").at(-1)).toEqual({
		body: { value: "" },
		status: 200,
	});

	await remount();
	expect(normalized(modelTrigger())).toContain("summary-local-model");
	expect(shownValue(effortSelect())).toBe("Provider default");
	expect(prefs.get("context.compact-model")).toBe("summary-local-model");
});

const LOCAL_KEY = "context.max-tokens.local";
const engineKey = (engine: string) => `context.max-tokens.engine.${engine}`;
const SCOPED_KEYS = [LOCAL_KEY, ...CORE_LOCAL_ENGINES.map(engineKey)];

/** Wait until the card has read `.local` and every local engine's key. */
async function scopedReads() {
	await settle(
		() =>
			SCOPED_KEYS.every((key) =>
				prefReads(key).some((call) => call.status > 0)
			),
		"scoped context budget reads"
	);
}

test("the context card warns that a scoped context.max-tokens.local override still trims turns while the global budget reads Off", async () => {
	seedPrefs({
		"context.max-tokens": "off",
		[LOCAL_KEY]: "auto",
	});
	await mount({ summarizer: false });
	await scopedReads();
	await settle(
		() =>
			pageText().includes(
				"Scoped override set: context.max-tokens.local = auto. It trims turns for local-engine agents even while this is Off."
			),
		"scoped note"
	);
	expect(pageText()).not.toContain("matching agents");
	expect(pageText()).toContain(
		"unless a scoped override (context.max-tokens.local or context.max-tokens.engine.<id>) is set."
	);
	expect(pageText()).not.toContain("ignored while it is off.");
	expect(writes(LOCAL_KEY)).toEqual([]);
	expect(prefs.get(LOCAL_KEY)).toBe("auto");
});

test("the context card surfaces a per-engine override for a local engine, the highest-precedence key", async () => {
	seedPrefs({
		"context.max-tokens": "off",
		[engineKey("llamacpp")]: "8192",
	});
	await mount({ summarizer: false });
	await scopedReads();
	expect(prefReads(LOCAL_KEY)[0]?.status).toBe(404);
	await settle(
		() =>
			pageText().includes(
				"Scoped override set: context.max-tokens.engine.llamacpp = 8192. It trims turns for agents on the llamacpp engine even while this is Off."
			),
		"engine note"
	);
	expect(writes(engineKey("llamacpp"))).toEqual([]);
});

test("the scoped-override note follows the global budget and an explicit off override", async () => {
	seedPrefs({
		"context.max-tokens": "8192",
		[LOCAL_KEY]: "4096",
		[engineKey("mlx")]: "off",
	});
	await mount();
	await scopedReads();
	await settle(
		() =>
			pageText().includes(
				"Scoped override set: context.max-tokens.local = 4096. It overrides this setting for local-engine agents."
			) &&
			pageText().includes(
				"Scoped override set: context.max-tokens.engine.mlx = off. It turns trimming off for agents on the mlx engine, overriding this setting."
			),
		"notes with a global budget"
	);
	expect(pageText()).not.toContain("even while this is Off");

	await unmount();
	seedPrefs({
		"context.max-tokens": "off",
		[engineKey("ollama")]: "off",
	});
	exchanges.length = 0;
	await mount({ summarizer: false });
	await scopedReads();
	await settle(
		() =>
			pageText().includes(
				"Scoped override set: context.max-tokens.engine.ollama = off. It also keeps trimming off for agents on the ollama engine."
			),
		"off note with the global budget off"
	);
	expect(pageText()).not.toContain("trims turns");
});

test("the context card shows no scoped-override note when no scoped key is set or the scoped value is blank", async () => {
	seedPrefs({ "context.max-tokens": "off" });
	await mount({ summarizer: false });
	await scopedReads();
	expect(prefReads(LOCAL_KEY)[0]?.status).toBe(404);
	expect(prefReads(engineKey("llamacpp"))[0]?.status).toBe(404);
	expect(pageText()).not.toContain("Scoped override set:");

	await unmount();
	seedPrefs({
		"context.max-tokens": "off",
		[LOCAL_KEY]: "   ",
		[engineKey("vllm")]: "",
	});
	exchanges.length = 0;
	await mount({ summarizer: false });
	await scopedReads();
	expect(prefReads(LOCAL_KEY)[0]?.status).toBe(200);
	expect(prefReads(engineKey("vllm"))[0]?.status).toBe(200);
	expect(pageText()).not.toContain("Scoped override set:");
});
