// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	closeSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { z } from "zod";
import { CORE_LOCAL_ENGINES } from "../../lib/api/local-engines.ts";
import type { Node } from "../../store/useNodeStore.ts";

// SOURCE-ONLY prospective current-integration baseline. No business module,
// method, provider, store hook, consent gate, or SDK response is substituted.
// Native HTTP and the fsynced JSON peer are finite host adapters, not Core auth
// or Core durable-store acceptance. Fresh component mounts and the independent
// Bun/HappyDOM gate boot below are explicitly distinct from physical browser reload.
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const priorActDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
const priorFetchDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"fetch"
);
const ownsDom = !GlobalRegistrator.isRegistered;
const ownedDirectory = mkdtempSync("/tmp/ryu-general-consumers-native-");
const fixtureErrors: string[] = [];
const runtimeErrors: string[] = [];
const unexpectedDestinations: string[] = [];
const fetchErrors: string[] = [];
const bodyErrors: string[] = [];
const waiters = new Set<() => void>();
const fixtureTimers = new Set<ReturnType<typeof nativeSetTimeout>>();
let activeHandlers = 0;
let activeFetches = 0;
let activeBodies = 0;
let sequence = 0;
let ownedOrigin = "";
let root: Root | null = null;
let rootHost: HTMLElement | null = null;
let domObserver: MutationObserver | null = null;
let activeChild: ReturnType<typeof Bun.spawn> | null = null;

const preferenceSchema = z.object({ value: z.string() }).strict();
const consentSchema = z
	.object({ include_sensitive_topics: z.boolean() })
	.strict();
const recordSchema = z
	.object({
		preferences: z.record(z.string(), z.string()),
		consent: z.record(z.string(), z.boolean()),
		unrelated: z
			.object({
				projectId: z.string(),
				revision: z.number(),
				bytes: z.string(),
			})
			.strict(),
	})
	.strict();
type PeerDocument = z.infer<typeof recordSchema>;
type PhysicalNode = "a" | "b";
interface Exchange {
	body: unknown;
	bodyConsumed: boolean;
	id: number;
	jwt: string;
	method: string;
	node: PhysicalNode;
	path: string;
	rawBody: string;
	responseText: string | null;
	status: number | null;
}
interface HeldReply {
	admitted: boolean;
	arrived: Promise<Exchange>;
	match: (call: Exchange) => boolean;
	release: () => void;
	released: Promise<void>;
	signalArrival: (call: Exchange) => void;
	status: 200 | 503;
}
const calls: Exchange[] = [];
const holds: HeldReply[] = [];
const localConservation = {
	ryu_timezone: "Europe/London",
	"general-proof-unrelated": '{"draft":"retain exactly","revision":7}',
	ryu_long_term_memory: "false",
	ryu_node_tab_override_enabled: "false",
	ryu_client_id: "general-consumers-native-client",
};
const memoryKeys = [
	"auto-recall-enabled",
	"auto-recall-top-k",
	"skills-disclosure",
	"tools.active_ranker",
	"context.max-tokens",
	"context.max-output-tokens",
	"context.auto-compact",
	"context.compact-model",
	"context.compact-effort",
	"context.compact-on-cache-expire",
	"context.handoff-on-model-change",
	// The context card also reads (never writes) every scoped
	// `context.max-tokens` override Core gives precedence over the global key:
	// `.local` plus each local engine's `.engine.<id>`. None is seeded, so each
	// reads as unset and the card shows no scoped-override note.
	"context.max-tokens.local",
	...CORE_LOCAL_ENGINES.map((engine) => `context.max-tokens.engine.${engine}`),
];
const privacyKeys = [
	"product-analytics-enabled",
	"community-stats-enabled",
	"profile-activity-enabled",
	"crash-reports-enabled",
	"diagnostics-export-enabled",
	"diagnostics-otlp-endpoint",
	"diagnostics-otlp-content-mode",
	"diagnostics-otlp-preset",
	"diagnostics-otlp-project",
	"diagnostics-otlp-region",
	"diagnostics-otlp-api-key-ref",
	"diagnostics-otlp-public-key-ref",
	"support-access-local-enabled",
	"support-access-local-expiry",
] as const;
const knownKeys = new Set<string>([...memoryKeys, ...privacyKeys]);
const healing = {
	enabled: true,
	auto_decide: false,
	cooldown_secs: 300,
	diagnose_effort: "low",
	diagnose_model: "",
	max_attempts: 1,
};
function pulse() {
	for (const wake of [...waiters]) {
		wake();
	}
}
function errorText(error: unknown) {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}
function atomicWrite(path: string, text: string) {
	const temporary = `${path}.pending`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const directoryFd = openSync(ownedDirectory, "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}
function documentPath(node: PhysicalNode) {
	return join(ownedDirectory, `${node}.json`);
}
function rawDocument(node: PhysicalNode) {
	return readFileSync(documentPath(node), "utf8");
}
function readDocument(node: PhysicalNode): PeerDocument {
	return recordSchema.parse(JSON.parse(rawDocument(node)));
}
function writeDocument(node: PhysicalNode, document: PeerDocument) {
	atomicWrite(
		documentPath(node),
		`${JSON.stringify(recordSchema.parse(document))}\n`
	);
}
function seedDocument(node: PhysicalNode): PeerDocument {
	return {
		preferences: {
			"auto-recall-enabled": node === "a" ? "true" : "false",
			"auto-recall-top-k": node === "a" ? "4" : "7",
			"skills-disclosure": "progressive",
			"tools.active_ranker": "needle2",
			"context.max-tokens": "0",
			"context.max-output-tokens": "0",
			"context.auto-compact": "false",
			"context.compact-model": "",
			"context.compact-effort": "",
			"context.compact-on-cache-expire": "false",
			"context.handoff-on-model-change": "false",
			"product-analytics-enabled": "false",
			"community-stats-enabled": "false",
			"profile-activity-enabled": "false",
			"crash-reports-enabled": "false",
			"diagnostics-export-enabled": "false",
			"diagnostics-otlp-endpoint": "https://collector.invalid/retained",
			"diagnostics-otlp-content-mode": "metadata_only",
			"support-access-local-enabled": "false",
			"support-access-local-expiry": "0",
			"unrelated-node-preference": `{"retain":"whole document","node":"${node}"}`,
		},
		consent: { "delegation-a": false, "delegation-b": true },
		unrelated: {
			projectId: `project-${node}`,
			revision: 19,
			bytes: "unchanged raw companion state",
		},
	};
}
function heldReply(match: HeldReply["match"], status: HeldReply["status"]) {
	let signalArrival: HeldReply["signalArrival"] = () => {
		throw new Error("Arrival resolver unavailable");
	};
	let release: HeldReply["release"] = () => {
		throw new Error("Release resolver unavailable");
	};
	const hold: HeldReply = {
		match,
		status,
		admitted: false,
		arrived: new Promise((resolve) => {
			signalArrival = resolve;
		}),
		signalArrival: (call) => signalArrival(call),
		released: new Promise((resolve) => {
			release = resolve;
		}),
		release: () => release(),
	};
	holds.push(hold);
	return hold;
}
function exactHeaderContract(request: Request, node: PhysicalNode): string {
	const headers = request.headers;
	if (headers.get("authorization") !== `Bearer general-peer-node-${node}`) {
		throw new Error("Undeclared node Bearer");
	}
	const jwt = headers.get("x-ryu-user-jwt");
	if (jwt !== "delegation-a" && jwt !== "delegation-b") {
		throw new Error("Undeclared delegated identity");
	}
	if (node === "b" && jwt !== "delegation-b") {
		throw new Error("Foreign delegated identity on node B");
	}
	if (headers.get("content-type") !== "application/json") {
		throw new Error("Noncanonical SDK content type");
	}
	if (
		headers.get("x-ryu-client-id") !== localConservation.ryu_client_id ||
		headers.get("x-ryu-client-label") !== "Desktop" ||
		headers.get("x-ryu-surface") !== "desktop"
	) {
		throw new Error("Incorrect actual Desktop client attribution");
	}
	const allowed = new Set([
		"host",
		"accept",
		"accept-encoding",
		"connection",
		"content-length",
		"user-agent",
		"authorization",
		"content-type",
		"x-ryu-user-jwt",
		"x-ryu-client-id",
		"x-ryu-client-label",
		"x-ryu-surface",
	]);
	for (const [name] of headers) {
		if (!allowed.has(name)) {
			throw new Error(`Undeclared request header ${name}`);
		}
	}
	return jwt;
}
function jsonReply(call: Exchange, data: unknown, status = 200) {
	const text = JSON.stringify(data);
	call.status = status;
	call.responseText = text;
	pulse();
	return new NativeResponse(text, {
		status,
		headers: {
			"content-type": "application/json",
			"x-general-proof-response-id": String(call.id),
		},
	});
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		activeHandlers += 1;
		pulse();
		try {
			const url = new URL(request.url);
			if (url.origin !== ownedOrigin || url.search || url.hash) {
				throw new Error("Undeclared origin/query/hash");
			}
			const route =
				/^\/(a|b)(\/api\/(?:preferences\/([^/]+)|memory\/settings|spaces|healing\/config))$/.exec(
					url.pathname
				);
			const physicalNode = route?.[1];
			const path = route?.[2];
			if ((physicalNode !== "a" && physicalNode !== "b") || !path) {
				throw new Error("Undeclared native peer route");
			}
			const jwt = exactHeaderContract(request, physicalNode);
			const rawBody = await request.text();
			let body: unknown = null;
			if (request.method === "GET") {
				if (rawBody !== "") {
					throw new Error("GET body is forbidden");
				}
			} else if (request.method === "PUT") {
				try {
					body = JSON.parse(rawBody);
				} catch {
					throw new Error("Invalid native JSON write");
				}
			} else {
				throw new Error("Undeclared method");
			}
			const rawKey = route?.[3];
			const key = rawKey === undefined ? null : decodeURIComponent(rawKey);
			if (key !== null) {
				if (rawKey !== encodeURIComponent(key)) {
					throw new Error("Noncanonical SDK preference path encoding");
				}
				if (!knownKeys.has(key)) {
					throw new Error("Undeclared preference key");
				}
				if (request.method === "PUT") {
					const value = preferenceSchema.parse(body).value;
					if (
						(key !== "auto-recall-enabled" &&
							key !== "product-analytics-enabled") ||
						(value !== "true" && value !== "false")
					) {
						throw new Error("Undeclared preference write/value");
					}
				}
			} else if (path === "/api/memory/settings") {
				if (request.method === "PUT") {
					consentSchema.parse(body);
				}
			} else if (request.method !== "GET") {
				throw new Error("Read-only peer route");
			}
			const call: Exchange = {
				id: ++sequence,
				node: physicalNode,
				path,
				method: request.method,
				jwt,
				rawBody,
				body,
				status: null,
				responseText: null,
				bodyConsumed: false,
			};
			calls.push(call);
			const hold = holds.find(
				(candidate) => !candidate.admitted && candidate.match(call)
			);
			if (hold) {
				hold.admitted = true;
				hold.signalArrival(call);
				pulse();
				await hold.released;
				if (hold.status === 503) {
					return jsonReply(
						call,
						{ error: "Declared external peer refusal; no durable mutation" },
						503
					);
				}
			}
			const document = readDocument(physicalNode);
			if (key !== null) {
				if (request.method === "GET") {
					return jsonReply(call, {
						key,
						value: document.preferences[key] ?? null,
					});
				}
				document.preferences[key] = preferenceSchema.parse(body).value;
				writeDocument(physicalNode, document);
				return jsonReply(call, { ok: true, key });
			}
			if (path === "/api/memory/settings") {
				if (request.method === "PUT") {
					document.consent[jwt] =
						consentSchema.parse(body).include_sensitive_topics;
					writeDocument(physicalNode, document);
				}
				return jsonReply(call, {
					include_sensitive_topics: document.consent[jwt],
				});
			}
			if (path === "/api/spaces") {
				return jsonReply(call, { spaces: [] });
			}
			if (path === "/api/healing/config") {
				return jsonReply(call, healing);
			}
			throw new Error("Peer branch not implemented");
		} catch (error) {
			fixtureErrors.push(errorText(error));
			return NativeResponse.json(
				{ error: "Finite native peer refused undeclared input" },
				{ status: 500 }
			);
		} finally {
			activeHandlers -= 1;
			pulse();
		}
	},
});
ownedOrigin = server.url.origin;
if (ownsDom) {
	GlobalRegistrator.register({ url: `${ownedOrigin}/mounted-general` });
}
const priorWindowFetchDescriptor = Object.getOwnPropertyDescriptor(
	window,
	"fetch"
);
const savedStorage = storageSnapshot();
for (const [key, value] of Object.entries(localConservation)) {
	localStorage.setItem(key, value);
}
localStorage.removeItem("ryu_session_token");
localStorage.removeItem("ryu_oidc_user");
localStorage.setItem("ryu:product-analytics-enabled", "false");
localStorage.setItem("ryu:crash-reports-enabled", "false");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Return unchanged native promises from body methods; the ledger only observes
// their completion. A received503 remains503 and its original parser error path.
function observeBody<T>(
	call: Exchange,
	promise: Promise<T>,
	extractText: (value: T) => string
) {
	activeBodies += 1;
	void promise.then(
		(value) => {
			try {
				if (call.bodyConsumed) {
					throw new Error(`Duplicate body receipt ${call.id}`);
				}
				const text = extractText(value);
				if (text !== call.responseText) {
					throw new Error(`Body bytes differ at ${call.id}`);
				}
				call.bodyConsumed = true;
			} catch (error) {
				bodyErrors.push(errorText(error));
			} finally {
				activeBodies -= 1;
				pulse();
			}
		},
		(error) => {
			bodyErrors.push(errorText(error));
			activeBodies -= 1;
			pulse();
		}
	);
	return promise;
}
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const nativeRequest = new NativeRequest(input, init);
		const url = new URL(nativeRequest.url);
		if (url.origin !== ownedOrigin) {
			unexpectedDestinations.push(url.href);
			throw new Error("General consumer proof refuses unowned egress");
		}
		activeFetches += 1;
		pulse();
		try {
			const response = await nativeFetch(nativeRequest);
			const id = Number(response.headers.get("x-general-proof-response-id"));
			const call = calls.find((entry) => entry.id === id);
			if (!call) {
				throw new Error("Native response has no admitted request/body ID");
			}
			if (response.status !== call.status) {
				throw new Error("Native response status differs");
			}
			const text = response.text.bind(response);
			const json = response.json.bind(response);
			response.text = () => observeBody(call, text(), (value) => value);
			response.json = () =>
				observeBody(call, json(), (value) => {
					const text = JSON.stringify(value);
					if (typeof text !== "string") {
						throw new Error(
							"Native JSON body cannot represent the admitted response"
						);
					}
					return text;
				});
			return response;
		} catch (error) {
			fetchErrors.push(errorText(error));
			throw error;
		} finally {
			activeFetches -= 1;
			pulse();
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;
const windowError = (event: ErrorEvent) => {
	runtimeErrors.push(event.message || errorText(event.error));
	pulse();
};
const windowRejection = (event: PromiseRejectionEvent) => {
	runtimeErrors.push(errorText(event.reason));
	pulse();
};
window.addEventListener("error", windowError);
window.addEventListener("unhandledrejection", windowRejection);

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { MemoryTab } = await import("./MemoryTab.tsx");
const { PrivacySettings } = await import("./PrivacySettings.tsx");
const { useActiveNode } = await import("../../hooks/useActiveNode.ts");
const { useNodeStore } = await import("../../store/useNodeStore.ts");
const { AppSurfaceProvider } = await import(
	"../../contexts/app-surface-context.tsx"
);
const { getMemorySettings } = await import("../../lib/api/memory.ts");
const { isAnalyticsEnabled, isAnalyticsConfigured } = await import(
	"../../lib/analytics.ts"
);
const { isCrashReportingEnabled, isCrashReportingConfigured } = await import(
	"../../lib/crash.ts"
);
const savedNodeState = useNodeStore.getState();
const queryClient = new QueryClient();
const first: Node = {
	name: "same-node",
	url: `${ownedOrigin}/a`,
	token: "general-peer-node-a",
	userJwt: "delegation-a",
};
const sameNodeDifferentJwt: Node = { ...first, userJwt: "delegation-b" };
const second: Node = {
	name: "different-node",
	url: `${ownedOrigin}/b`,
	token: "general-peer-node-b",
	userJwt: "delegation-b",
};

function storageSnapshot(): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key === null) {
			throw new Error("Native Storage key disappeared during snapshot");
		}
		const value = localStorage.getItem(key);
		if (value === null) {
			throw new Error("Native Storage value disappeared during snapshot");
		}
		values[key] = value;
	}
	return values;
}
function restoreStorage(values: Record<string, string>) {
	localStorage.clear();
	for (const [key, value] of Object.entries(values)) {
		localStorage.setItem(key, value);
	}
}
function select(node: Node) {
	useNodeStore.setState({
		nodes: [node],
		localNodes: [],
		defaultNode: node.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		activeNodeOnline: null,
	});
}
function ActiveNodeConsumer() {
	const node = useActiveNode();
	return (
		<output
			data-general-active-jwt={node.userJwt ?? ""}
			data-general-active-node={node.url}
		>
			{node.name}
		</output>
	);
}
function activeNodeAcknowledged(node: Node) {
	const consumer = document.querySelector("[data-general-active-node]");
	return (
		consumer?.getAttribute("data-general-active-node") === node.url &&
		consumer.getAttribute("data-general-active-jwt") === node.userJwt
	);
}
function observeDom() {
	domObserver = new MutationObserver(pulse);
	domObserver.observe(document.body, {
		subtree: true,
		attributes: true,
		childList: true,
		characterData: true,
	});
}
async function waitFor(
	check: () => boolean,
	description: string,
	timeoutMs = 3000
) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`No actual acknowledgment: ${description}`);
		}
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				nativeClearTimeout(timer);
				fixtureTimers.delete(timer);
				waiters.delete(wake);
				resolve();
			};
			const timer = nativeSetTimeout(
				() => {
					fixtureTimers.delete(timer);
					waiters.delete(wake);
					reject(new Error(`No actual acknowledgment: ${description}`));
				},
				Math.max(1, deadline - Date.now())
			);
			fixtureTimers.add(timer);
			waiters.add(wake);
			if (check()) {
				wake();
			}
		});
	}
}
async function settledAct(check: () => boolean, description: string) {
	await act(async () => {
		await waitFor(check, description);
		await Promise.resolve();
	});
}
async function consumeAll(marker = 0) {
	await settledAct(
		() =>
			activeHandlers === 0 &&
			activeFetches === 0 &&
			activeBodies === 0 &&
			calls
				.slice(marker)
				.every((entry) => entry.status !== null && entry.bodyConsumed),
		"every real server response/client body joined"
	);
}
async function mount(content: ReactNode) {
	if (root !== null) {
		throw new Error("A real root is already mounted");
	}
	rootHost = document.createElement("div");
	document.body.append(rootHost);
	root = createRoot(rootHost, {
		onCaughtError: (error) => runtimeErrors.push(errorText(error)),
		onUncaughtError: (error) => runtimeErrors.push(errorText(error)),
		onRecoverableError: (error) => runtimeErrors.push(errorText(error)),
	});
	const actualRoot = root;
	await act(async () => {
		actualRoot.render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter>
					<AppSurfaceProvider surface="desktop">
						<I18nProvider
							autoLocalizeDom={false}
							initialLocale="en"
							initialPackId="official/en"
						>
							<ActiveNodeConsumer />
							{content}
							<Toaster />
						</I18nProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</QueryClientProvider>
		);
	});
}
async function unmount() {
	if (root !== null) {
		const actualRoot = root;
		root = null;
		await act(async () => {
			sileo.clear();
			actualRoot.unmount();
			await Promise.resolve();
		});
	}
	rootHost?.remove();
	rootHost = null;
	await consumeAll();
}
function memorySwitch(label: string) {
	const control = document.querySelector<HTMLElement>(
		`[role="switch"][aria-label="${label}"]`
	);
	if (!control) {
		throw new Error(`Missing actual Memory switch ${label}`);
	}
	return control;
}
function recallSwitch() {
	return memorySwitch("Automatically recall relevant context");
}
function consentSwitch() {
	return memorySwitch("Include sensitive topics in memory");
}
function checked(control: HTMLElement) {
	return control.getAttribute("aria-checked") === "true";
}
function input(label: string) {
	const control = document.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`
	);
	if (!control) {
		throw new Error(`Missing actual Memory input ${label}`);
	}
	return control;
}
async function click(control: HTMLElement) {
	if (
		control.getAttribute("aria-disabled") === "true" ||
		control.hasAttribute("disabled")
	) {
		throw new Error("The genuine control is disabled");
	}
	await act(async () => {
		control.click();
		await Promise.resolve();
	});
}
async function setDraft() {
	const draft = input("Search query");
	const nativeValueSetter = Object.getOwnPropertyDescriptor(
		window.HTMLInputElement.prototype,
		"value"
	)?.set;
	if (!nativeValueSetter) {
		throw new Error("Native input setter is missing");
	}
	await act(async () => {
		nativeValueSetter.call(draft, "unsent native draft");
		draft.dispatchEvent(new window.Event("input", { bubbles: true }));
		draft.focus();
	});
	return draft;
}
async function memoryReads(node: Node, marker: number) {
	const physical = node.url === first.url ? "a" : "b";
	await settledAct(() => {
		const own = calls
			.slice(marker)
			.filter(
				(entry) =>
					entry.node === physical &&
					entry.jwt === node.userJwt &&
					entry.method === "GET" &&
					entry.bodyConsumed &&
					entry.status === 200
			);
		return (
			memoryKeys.every((key) =>
				own.some((entry) => entry.path === `/api/preferences/${key}`)
			) &&
			own.some((entry) => entry.path === "/api/memory/settings") &&
			own.some((entry) => entry.path === "/api/spaces")
		);
	}, "all genuine Memory reads for the selected exact authority");
	// A formerly selected write may legitimately remain held while the current
	// node's reads finish. Require every new selected response/body, not global
	// zero handlers, until that separately owned held response is released.
	await settledAct(
		() =>
			calls
				.slice(marker)
				.every((entry) => entry.status !== null && entry.bodyConsumed),
		"selected Memory response/body closure while an older write may remain held"
	);
}
function privacySwitch() {
	const row = [
		...document.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	].find(
		(entry) =>
			entry.querySelector('[data-slot="item-title"]')?.textContent?.trim() ===
			"Share anonymous usage analytics"
	);
	const control = row?.querySelector<HTMLElement>('[role="switch"]');
	if (!control) {
		throw new Error("Missing actual Privacy analytics switch");
	}
	return control;
}
async function privacyReads(marker: number) {
	await settledAct(
		() =>
			privacyKeys.every((key) =>
				calls
					.slice(marker)
					.some(
						(entry) =>
							entry.node === "a" &&
							entry.jwt === first.userJwt &&
							entry.method === "GET" &&
							entry.path === `/api/preferences/${key}` &&
							entry.status === 200 &&
							entry.bodyConsumed
					)
			) &&
			calls
				.slice(marker)
				.some(
					(entry) =>
						entry.path === "/api/healing/config" &&
						entry.bodyConsumed &&
						entry.status === 200
				),
		"all actual Privacy preferences and healing bodies"
	);
	await consumeAll(marker);
}
async function openUsagePage() {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((entry) => entry.textContent?.includes("Usage & crash data"));
	if (!button) {
		throw new Error("Missing actual Usage & crash data navigation");
	}
	await click(button);
}
function expectLocalConserved() {
	for (const [key, value] of Object.entries(localConservation)) {
		expect(localStorage.getItem(key)).toBe(value);
	}
}
function expectClean() {
	expect(fixtureErrors).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expect(unexpectedDestinations).toEqual([]);
	expect(fetchErrors).toEqual([]);
	expect(bodyErrors).toEqual([]);
	expect(activeHandlers).toBe(0);
	expect(activeFetches).toBe(0);
	expect(activeBodies).toBe(0);
	expect(
		calls.every((entry) => entry.status !== null && entry.bodyConsumed)
	).toBe(true);
	expect(fixtureTimers.size).toBe(0);
	expect(activeChild).toBeNull();
}
function writesAfter(marker: number) {
	return calls.slice(marker).filter((entry) => entry.method === "PUT");
}
function expectWrite(
	call: Exchange,
	node: PhysicalNode,
	jwt: string,
	path: string,
	body: unknown,
	status: number
) {
	expect({
		node: call.node,
		jwt: call.jwt,
		path: call.path,
		method: call.method,
		body: call.body,
		status: call.status,
		consumed: call.bodyConsumed,
	}).toEqual({ node, jwt, path, method: "PUT", body, status, consumed: true });
}
function onlyWrite(marker: number) {
	const own = writesAfter(marker);
	expect(own.length).toBe(1);
	const call = own[0];
	if (!call) {
		throw new Error("Expected one genuine SDK write");
	}
	return call;
}
async function freshGateBoot() {
	const snapshot = storageSnapshot();
	const path = join(ownedDirectory, "saved-browser-storage.json");
	atomicWrite(path, JSON.stringify(snapshot));
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "privacy-gate-fresh-boot.ts"),
			path,
		],
		{
			cwd: join(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, VITE_POSTHOG_KEY: "", VITE_SENTRY_DSN: "" },
		}
	);
	activeChild = child;
	const timeout = nativeSetTimeout(() => {
		child.kill();
	}, 8000);
	fixtureTimers.add(timeout);
	try {
		const [stdout, stderr, exit] = await Promise.all([
			new NativeResponse(child.stdout).text(),
			new NativeResponse(child.stderr).text(),
			child.exited,
		]);
		expect(exit).toBe(0);
		expect(stderr).toBe("");
		const result = z
			.object({
				analytics: z.boolean(),
				crash: z.boolean(),
				storage: z.record(z.string(), z.string()),
				unexpectedHttp: z.array(z.string()),
				ownedDomUnregistered: z.literal(true),
			})
			.strict()
			.parse(JSON.parse(stdout));
		expect(result.storage).toEqual(snapshot);
		expect(result.unexpectedHttp).toEqual([]);
		return result;
	} finally {
		nativeClearTimeout(timeout);
		fixtureTimers.delete(timeout);
		if (child.exitCode === null) {
			child.kill();
		}
		await child.exited;
		activeChild = null;
	}
}

beforeEach(() => {
	expectClean();
	calls.length = 0;
	holds.length = 0;
	for (const node of ["a", "b"] as const) {
		writeDocument(node, seedDocument(node));
	}
	// Per-case initial conditions only. Reload/fresh-mount witnesses never clear
	// or reseed either peer documents or Storage.
	restoreStorage({
		...savedStorage,
		...localConservation,
		"ryu:product-analytics-enabled": "false",
		"ryu:crash-reports-enabled": "false",
	});
	localStorage.removeItem("ryu_session_token");
	localStorage.removeItem("ryu_oidc_user");
	queryClient.clear();
	select(first);
	observeDom();
});
afterEach(async () => {
	const failures: unknown[] = [];
	for (const hold of holds) {
		hold.release();
	}
	try {
		await consumeAll();
	} catch (error) {
		failures.push(error);
	}
	try {
		await unmount();
	} catch (error) {
		failures.push(error);
	}
	domObserver?.disconnect();
	domObserver = null;
	try {
		expect(
			queryClient
				.getQueryCache()
				.getAll()
				.every((query) => query.getObserversCount() === 0)
		).toBe(true);
	} catch (error) {
		failures.push(error);
	}
	queryClient.clear();
	try {
		expectClean();
	} catch (error) {
		failures.push(error);
	}
	useNodeStore.setState(savedNodeState);
	if (failures.length) {
		throw new AggregateError(
			failures,
			"Actual General consumer teardown failed"
		);
	}
});
afterAll(async () => {
	const failures: unknown[] = [];
	try {
		await server.stop();
		await consumeAll();
		expectClean();
	} catch (error) {
		failures.push(error);
	} finally {
		window.removeEventListener("error", windowError);
		window.removeEventListener("unhandledrejection", windowRejection);
		restoreStorage(savedStorage);
		if (priorWindowFetchDescriptor) {
			Object.defineProperty(window, "fetch", priorWindowFetchDescriptor);
		} else {
			Reflect.deleteProperty(window, "fetch");
		}
		if (priorFetchDescriptor) {
			Object.defineProperty(globalThis, "fetch", priorFetchDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, "fetch");
		}
		if (priorActDescriptor) {
			Object.defineProperty(
				globalThis,
				"IS_REACT_ACT_ENVIRONMENT",
				priorActDescriptor
			);
		} else {
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		}
		if (ownsDom) {
			await GlobalRegistrator.unregister();
		}
		rmSync(ownedDirectory, { recursive: true, force: true });
	}
	if (failures.length) {
		throw new AggregateError(
			failures,
			"Actual native peer final closure failed"
		);
	}
});

test("JWT-only Memory selection retires old delegated consent and retries only the current user", async () => {
	const aBefore = rawDocument("a");
	const bBefore = rawDocument("b");
	await mount(<MemoryTab />);
	await memoryReads(first, 0);
	expect(activeNodeAcknowledged(first)).toBe(true);
	expect(checked(consentSwitch())).toBe(false);
	const originalConsentControl = consentSwitch();
	// Genuine independent SDK read establishes that delegated B data is actually
	// available. Only later producer reads count as the rotation acknowledgment.
	expect(await getMemorySettings(sameNodeDifferentJwt)).toEqual({
		includeSensitiveTopics: true,
	});
	await consumeAll();
	expect(readDocument("a").consent["delegation-b"]).toBe(true);
	const rotationMarker = calls.length;
	await act(async () => {
		select(sameNodeDifferentJwt);
	});
	await settledAct(
		() => activeNodeAcknowledged(sameNodeDifferentJwt),
		"real active-node consumer selects JWT B at unchanged URL/token/name"
	);
	await settledAct(
		() =>
			calls
				.slice(rotationMarker)
				.some(
					(entry) =>
						entry.path === "/api/memory/settings" &&
						entry.jwt === "delegation-b" &&
						entry.method === "GET" &&
						entry.bodyConsumed &&
						entry.status === 200
				),
		"fresh genuine delegated B Memory consent read"
	);
	expect(consentSwitch()).toBe(originalConsentControl);
	expect(checked(consentSwitch())).toBe(true);
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	const refused = heldReply(
		(call) =>
			call.node === "a" &&
			call.jwt === "delegation-b" &&
			call.path === "/api/memory/settings" &&
			call.method === "PUT",
		503
	);
	const refusalMarker = calls.length;
	await click(consentSwitch());
	const refusalCall = await refused.arrived;
	expect(refusalCall.body).toEqual({ include_sensitive_topics: false });
	refused.release();
	await consumeAll(refusalMarker);
	await settledAct(
		() =>
			checked(consentSwitch()) &&
			document.body.textContent?.includes(
				"Couldn't save sensitive-memory consent"
			) === true,
		"real save refusal restores current B consent and visible error"
	);
	expectWrite(
		onlyWrite(refusalMarker),
		"a",
		"delegation-b",
		"/api/memory/settings",
		{ include_sensitive_topics: false },
		503
	);
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
	const retryMarker = calls.length;
	await click(consentSwitch());
	await consumeAll(retryMarker);
	expectWrite(
		onlyWrite(retryMarker),
		"a",
		"delegation-b",
		"/api/memory/settings",
		{ include_sensitive_topics: false },
		200
	);
	const expected = recordSchema.parse(JSON.parse(aBefore));
	expected.consent["delegation-b"] = false;
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expect(checked(consentSwitch())).toBe(false);
	expectLocalConserved();
	await unmount();
	const reloadMarker = calls.length;
	await mount(<MemoryTab />);
	await memoryReads(sameNodeDifferentJwt, reloadMarker);
	expect(checked(consentSwitch())).toBe(false);
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
}, 20_000);

test("a failed former-node auto-recall write cannot restore its old value or error on selected node B", async () => {
	const aBefore = rawDocument("a");
	const bBefore = rawDocument("b");
	await mount(<MemoryTab />);
	await memoryReads(first, 0);
	expect(checked(recallSwitch())).toBe(true);
	expect(input("Snippets recalled per reply").value).toBe("4");
	const old = heldReply(
		(call) =>
			call.node === "a" &&
			call.path === "/api/preferences/auto-recall-enabled" &&
			call.method === "PUT",
		503
	);
	await click(recallSwitch());
	const oldCall = await old.arrived;
	expect(oldCall.body).toEqual({ value: "false" });
	expect(rawDocument("a")).toBe(aBefore);
	const draft = await setDraft();
	const switchNode = recallSwitch();
	const selectionMarker = calls.length;
	await act(async () => {
		select(second);
	});
	await memoryReads(second, selectionMarker);
	expect(activeNodeAcknowledged(second)).toBe(true);
	expect(recallSwitch()).toBe(switchNode);
	expect(checked(recallSwitch())).toBe(false);
	expect(input("Snippets recalled per reply").value).toBe("7");
	expect(document.activeElement).toBe(draft);
	expect(draft.value).toBe("unsent native draft");
	old.release();
	await consumeAll();
	expectWrite(
		oldCall,
		"a",
		"delegation-a",
		"/api/preferences/auto-recall-enabled",
		{ value: "false" },
		503
	);
	// This negative boundary follows the genuine old client body receipt and act
	// settlement, rather than elapsed sleep or mere server-response release.
	expect(checked(recallSwitch())).toBe(false);
	expect(input("Snippets recalled per reply").value).toBe("7");
	expect(document.body.textContent?.includes("Couldn't save auto-recall")).toBe(
		false
	);
	expect(recallSwitch().getAttribute("aria-disabled")).not.toBe("true");
	expect(document.activeElement).toBe(draft);
	expect(input("Search query")).toBe(draft);
	expect(draft.value).toBe("unsent native draft");
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
	const refusal = heldReply(
		(call) =>
			call.node === "b" &&
			call.path === "/api/preferences/auto-recall-enabled" &&
			call.method === "PUT",
		503
	);
	const refusalMarker = calls.length;
	await click(recallSwitch());
	await refusal.arrived;
	refusal.release();
	await consumeAll(refusalMarker);
	await settledAct(
		() =>
			!checked(recallSwitch()) &&
			document.body.textContent?.includes("Couldn't save auto-recall") === true,
		"selected B refused write retains false and shows actual error"
	);
	expectWrite(
		onlyWrite(refusalMarker),
		"b",
		"delegation-b",
		"/api/preferences/auto-recall-enabled",
		{ value: "true" },
		503
	);
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	const retryMarker = calls.length;
	await click(recallSwitch());
	await consumeAll(retryMarker);
	expectWrite(
		onlyWrite(retryMarker),
		"b",
		"delegation-b",
		"/api/preferences/auto-recall-enabled",
		{ value: "true" },
		200
	);
	const expected = recordSchema.parse(JSON.parse(bBefore));
	expected.preferences["auto-recall-enabled"] = "true";
	expect(readDocument("b")).toEqual(expected);
	expect(rawDocument("a")).toBe(aBefore);
	expectLocalConserved();
	await unmount();
	const reloadMarker = calls.length;
	await mount(<MemoryTab />);
	await memoryReads(second, reloadMarker);
	expect(checked(recallSwitch())).toBe(true);
	expect(input("Snippets recalled per reply").value).toBe("7");
	expect(readDocument("b")).toEqual(expected);
	expect(rawDocument("a")).toBe(aBefore);
	expectLocalConserved();
}, 20_000);

test("Privacy analytics enable keeps the shipping live gate off until durable acknowledgment and recovers after refusal", async () => {
	expect(isAnalyticsConfigured()).toBe(false);
	expect(isCrashReportingConfigured()).toBe(false);
	const aBefore = rawDocument("a");
	const bBefore = rawDocument("b");
	await mount(<PrivacySettings />);
	await privacyReads(0);
	await openUsagePage();
	expect(checked(privacySwitch())).toBe(false);
	expect(isAnalyticsEnabled()).toBe(false);
	expect(isCrashReportingEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("false");
	expect(localStorage.getItem("ryu:crash-reports-enabled")).toBe("false");
	const rejected = heldReply(
		(call) =>
			call.node === "a" &&
			call.path === "/api/preferences/product-analytics-enabled" &&
			call.method === "PUT",
		503
	);
	const refusalMarker = calls.length;
	await click(privacySwitch());
	const refusalCall = await rejected.arrived;
	expect(refusalCall.body).toEqual({ value: "true" });
	expect(refusalCall.status).toBeNull();
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expect(
		privacySwitch().getAttribute("aria-disabled") === "true" ||
			privacySwitch().hasAttribute("disabled")
	).toBe(true);
	// Positive held-handler admission proves the enable action is in flight, but
	// the acknowledged durable choice remains disabled. Do not arm collection yet.
	expect(isAnalyticsEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("false");
	expect(isCrashReportingEnabled()).toBe(false);
	expectLocalConserved();
	rejected.release();
	await consumeAll(refusalMarker);
	await settledAct(
		() =>
			!checked(privacySwitch()) &&
			document.body.textContent?.includes(
				"Couldn't save your analytics choice"
			) === true,
		"actual Privacy refused enable/error recovery"
	);
	expectWrite(
		onlyWrite(refusalMarker),
		"a",
		"delegation-a",
		"/api/preferences/product-analytics-enabled",
		{ value: "true" },
		503
	);
	expect(isAnalyticsEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("false");
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
	const retryMarker = calls.length;
	await click(privacySwitch());
	await consumeAll(retryMarker);
	expectWrite(
		onlyWrite(retryMarker),
		"a",
		"delegation-a",
		"/api/preferences/product-analytics-enabled",
		{ value: "true" },
		200
	);
	expect(checked(privacySwitch())).toBe(true);
	expect(isAnalyticsEnabled()).toBe(true);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("true");
	const expected = recordSchema.parse(JSON.parse(aBefore));
	expected.preferences["product-analytics-enabled"] = "true";
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expect(isCrashReportingEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:crash-reports-enabled")).toBe("false");
	expectLocalConserved();
	await unmount();
	// A genuine fresh process imports the unchanged gate modules after restoring
	// exactly the saved native Storage bytes. Its startup seed is independent of
	// this process's module cache; it makes no claim about physical browser storage.
	const boot = await freshGateBoot();
	expect(boot.analytics).toBe(true);
	expect(boot.crash).toBe(false);
	const reloadMarker = calls.length;
	await mount(<PrivacySettings />);
	await privacyReads(reloadMarker);
	await openUsagePage();
	expect(checked(privacySwitch())).toBe(true);
	expect(isAnalyticsEnabled()).toBe(true);
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expect(isCrashReportingEnabled()).toBe(false);
	expectLocalConserved();
}, 25_000);
