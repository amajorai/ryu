// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { NodeDefaultModel } from "@/src/hooks/useNodeDefaultModel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

// The mounted shipping producer, query consumers and SDK stay intact. Only
// their external HTTP peer is owned by this invocation. This does not execute
// Core authorization, SQLite, provider inference or a native OS keychain.
const nativeFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTextEncoder = globalThis.TextEncoder;
const nativeResponseText = NativeResponse.prototype.text;
const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
const registeredAbortController = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortController"
);
const registeredAbortSignal = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortSignal"
);
// Bun's native HTTP Request accepts its own genuine abort primitives. Keep
// those intact rather than replacing the SDK or translating cancellation.
Object.defineProperty(globalThis, "AbortController", {
	configurable: true,
	writable: true,
	value: NativeAbortController,
});
Object.defineProperty(globalThis, "AbortSignal", {
	configurable: true,
	writable: true,
	value: NativeAbortSignal,
});
const previousActFlag = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const localKey = "default-local-agent-selection";
const cloudKey = "default-cloud-agent-selection";
const idleKey = "engine.llamacpp.sleep-idle-seconds";
const entitlementKeys = new Set([
	"entitlement-active",
	"managed-inference-entitled",
]);
const directory = await mkdtemp(join(tmpdir(), "ryu-defaults-consumer-"));
const stateFile = join(directory, "preferences.json");
type Owner = "a" | "foreign";
type Records = Record<Owner, Record<string, string>>;
interface Call {
	bearer: string | null;
	body: unknown;
	clientId: string | null;
	delegation: string | null;
	id: number;
	method: string;
	owner: Owner | null;
	status: number;
	url: string;
}
interface BodyRead {
	id: number;
	status: number;
	text: string;
}
interface HeldBody {
	cancelled: string | null;
	id: number;
	release: () => void;
	released: boolean;
	text: string;
}
const calls: Call[] = [];
const bodyReads: BodyRead[] = [];
const bodyReadStarts: number[] = [];
const heldBodies: HeldBody[] = [];
const unexpected: string[] = [];
const transportErrors: string[] = [];
const nativeExchanges = new Set<Promise<Response>>();
const nativeBodyObservations = new Set<Promise<string>>();
const returnedBodies = new Set<number>();
const transportWaiters = new Set<() => void>();
const allowed = new Map<string, Owner>();
let records: Records;
let refusedLocalWrites = 0;
let activeHandlers = 0;
let nextCallId = 0;
let persistence = Promise.resolve();
let publicationId = 0;
let diagnosticCase = 0;
let holdLocalReadCredentials: { bearer: string; delegation: string } | null =
	null;
let refuseLocalReadCredentials: { bearer: string; delegation: string } | null =
	null;
const diagnosticDirectory = process.env.RYU_DEFAULTS_PROOF_ARTIFACTS;

function notifyTransportChange() {
	for (const wake of [...transportWaiters]) {
		wake();
	}
}
function waitForTransportChange() {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			transportWaiters.delete(wake);
			reject(
				new Error(
					"Actual returned HTTP body did not finish its decoder observation"
				)
			);
		}, 4000);
		const wake = () => {
			clearTimeout(timer);
			transportWaiters.delete(wake);
			resolve();
		};
		transportWaiters.add(wake);
	});
}
async function settleNativeTransport() {
	while (
		nativeExchanges.size ||
		nativeBodyObservations.size ||
		returnedBodies.size
	) {
		const pending = [...nativeExchanges, ...nativeBodyObservations];
		if (pending.length) {
			await Promise.allSettled(pending);
		} else {
			await waitForTransportChange();
		}
	}
}

function selection(model: string): AgentSelection {
	return {
		agent_id: "",
		provider: "",
		model,
		thinking_level: "",
		effort: "",
		access_mode: "",
	};
}
function seed(model: string): Record<string, string> {
	return {
		[localKey]: JSON.stringify(selection(model)),
		[cloudKey]: JSON.stringify(selection("cloud-preserved")),
		[idleKey]: "300",
		"entitlement-active": "true",
		"managed-inference-entitled": "false",
		"unrelated-defaults-proof": "preserved",
	};
}
async function persistRecords() {
	const payload = JSON.stringify(records);
	const temporary = join(directory, `preferences-${++publicationId}.tmp`);
	const publication = persistence.then(async () => {
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(payload);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, stateFile);
			const parent = await open(directory, "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		} finally {
			await rm(temporary, { force: true });
		}
	});
	// A refused publication still rejects its own caller; later owned writes
	// can recover without concurrent truncation or an unhandled queue rejection.
	persistence = publication.catch(() => undefined);
	await publication;
}
async function independentlyReadRecords(): Promise<Records> {
	const value: unknown = JSON.parse(await readFile(stateFile, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid owned preference ledger");
	}
	for (const owner of ["a", "foreign"] as const) {
		const entry: unknown = Reflect.get(value, owner);
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Missing owned preference namespace ${owner}`);
		}
		if (Object.values(entry).some((field) => typeof field !== "string")) {
			throw new Error("Invalid stored preference value");
		}
	}
	return value as Records;
}
function recordBody(raw: string): unknown {
	if (raw === "") {
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
function preferenceBody(value: unknown): value is { value: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		typeof Reflect.get(value, "value") === "string"
	);
}

function holdNativeJsonBody(call: Call, body: unknown) {
	const text = JSON.stringify(body);
	const bytes = new NativeTextEncoder().encode(text);
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const held: HeldBody = {
		id: call.id,
		text,
		released: false,
		cancelled: null,
		release() {
			if (held.released || held.cancelled !== null) {
				return;
			}
			if (!controller) {
				throw new Error("Native response body has no stream controller");
			}
			controller.enqueue(bytes.subarray(1));
			controller.close();
			held.released = true;
		},
	};
	const stream = new NativeReadableStream<Uint8Array>({
		start(next) {
			controller = next;
			// Send genuine headers and a partial JSON byte over HTTP. The SDK's
			// actual awaited text decoder cannot finish until the rest is released.
			next.enqueue(bytes.subarray(0, 1));
		},
		cancel(reason: unknown) {
			held.cancelled = String(reason);
			transportErrors.push(
				`Held native body ${call.id} cancelled: ${String(reason)}`
			);
		},
	});
	heldBodies.push(held);
	call.status = 200;
	return new NativeResponse(stream, {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-defaults-proof-call": String(call.id),
		},
	});
}
function heldBodySnapshot() {
	return heldBodies.map(({ id, text, released, cancelled }) => ({
		id,
		text,
		released,
		cancelled,
	}));
}
function releaseHeldBodies() {
	holdLocalReadCredentials = null;
	for (const body of heldBodies) {
		body.release();
	}
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		activeHandlers += 1;
		const url = new URL(request.url);
		const bearer = request.headers.get("authorization");
		const delegation = request.headers.get("x-ryu-user-jwt");
		const owner = allowed.get(`${bearer}|${delegation}`) ?? null;
		const call: Call = {
			id: ++nextCallId,
			owner,
			url: request.url,
			method: request.method,
			bearer,
			delegation,
			clientId: request.headers.get("x-ryu-client-id"),
			body: null,
			status: 0,
		};
		calls.push(call);
		const send = (status: number, body: unknown) => {
			call.status = status;
			return NativeResponse.json(body, {
				status,
				headers: { "x-defaults-proof-call": String(call.id) },
			});
		};
		const refuse = (reason: string, status = 422) => {
			unexpected.push(reason);
			return send(status, { error: reason });
		};
		try {
			const raw = await request.text();
			call.body = recordBody(raw);
			const routeOwner = url.pathname.startsWith("/node/api/")
				? "a"
				: url.pathname.startsWith("/foreign/api/")
					? "foreign"
					: null;
			if (
				url.origin !== server.url.origin ||
				routeOwner === null ||
				owner !== routeOwner ||
				request.headers.get("x-ryu-buyer-token") !== null ||
				call.clientId !== "defaults-proof-client" ||
				request.headers.get("content-type") !== "application/json"
			) {
				return refuse(
					`Undeclared admission ${request.method} ${request.url}`,
					401
				);
			}
			const route = url.pathname.slice(
				routeOwner === "a" ? "/node".length : "/foreign".length
			);
			if (route === "/api/gateway/audit") {
				if (
					request.method !== "GET" ||
					url.search !== "?limit=50" ||
					raw !== ""
				) {
					return refuse("Undeclared audit request");
				}
				return send(200, { reachable: true, entries: [], count: 0 });
			}
			if (url.search !== "") {
				return refuse(`Undeclared query ${url.search}`);
			}
			if (route.startsWith("/api/preferences/")) {
				const key = decodeURIComponent(route.slice("/api/preferences/".length));
				if (
					!(
						[localKey, cloudKey, idleKey].includes(key) ||
						entitlementKeys.has(key)
					)
				) {
					return refuse(`Undeclared preference ${key}`);
				}
				if (request.method === "GET" && raw === "") {
					const persisted = await independentlyReadRecords();
					const body = { key, value: persisted[routeOwner][key] ?? null };
					if (
						key === localKey &&
						routeOwner === "a" &&
						refuseLocalReadCredentials !== null &&
						bearer === refuseLocalReadCredentials.bearer &&
						delegation === refuseLocalReadCredentials.delegation
					) {
						return send(503, { error: "Owned preference read refused" });
					}
					if (
						key === localKey &&
						routeOwner === "a" &&
						holdLocalReadCredentials !== null &&
						bearer === holdLocalReadCredentials.bearer &&
						delegation === holdLocalReadCredentials.delegation
					) {
						return holdNativeJsonBody(call, body);
					}
					return send(200, body);
				}
				if (request.method !== "PUT" || !preferenceBody(call.body)) {
					return refuse("Undeclared preference write");
				}
				if (key !== localKey && !entitlementKeys.has(key)) {
					return refuse(`Undeclared writable preference ${key}`);
				}
				if (key === localKey && refusedLocalWrites > 0) {
					refusedLocalWrites -= 1;
					return send(503, { error: "Owned preference write refused" });
				}
				records[routeOwner][key] = call.body.value;
				await persistRecords();
				return send(200, { ok: true, key });
			}
			if (request.method === "GET" && raw === "") {
				if (route === "/api/agents") {
					return send(200, { agents: [] });
				}
				if (route === "/api/engines") {
					return send(200, { engines: [] });
				}
				if (route === "/api/engine/active") {
					return send(200, { active: null, running: false, available: [] });
				}
				if (route === "/api/pi-config/catalog") {
					return send(200, { apiTypes: [], providers: [], thinkingLevels: [] });
				}
				if (route === "/api/gateway/evaluators") {
					return send(200, { evaluators: [] });
				}
			}
			if (route === "/api/gateway/evals/run" && request.method === "POST") {
				const expectedBody = {
					agent_id: null,
					model: JSON.parse(
						(await independentlyReadRecords())[routeOwner][localKey] ?? "{}"
					).model,
					dataset: [],
					evaluators: [],
					code_evaluators: [],
				};
				if (JSON.stringify(call.body) !== JSON.stringify(expectedBody)) {
					return refuse(
						"Eval consumer sent an undeclared default or request body"
					);
				}
				// This proves the real run client/error consumer, not an inference result.
				return send(503, { error: "Owned inference provider unavailable" });
			}
			return refuse(`Undeclared route ${request.method} ${route}`, 404);
		} finally {
			activeHandlers -= 1;
		}
	},
});

// Observe the SDK's genuine awaited text read without changing its bytes or
// status. The response belongs to the native HTTP connection, not a mock fetch.
NativeResponse.prototype.text = function (this: Response) {
	const id = this.headers.get("x-defaults-proof-call");
	if (id !== null) {
		bodyReadStarts.push(Number(id));
	}
	const observation = (async () => {
		const text = await nativeResponseText.call(this);
		if (id !== null) {
			bodyReads.push({ id: Number(id), status: this.status, text });
		}
		return text;
	})();
	nativeBodyObservations.add(observation);
	const complete = () => {
		nativeBodyObservations.delete(observation);
		if (id !== null) {
			returnedBodies.delete(Number(id));
		}
		notifyTransportChange();
	};
	void observation.then(complete, (error: unknown) => {
		transportErrors.push(
			`Native body ${id ?? "unidentified"}: ${String(error)}`
		);
		complete();
	});
	return observation;
};
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		if (new URL(request.url).origin !== server.url.origin) {
			unexpected.push(`Unowned fetch ${request.method} ${request.url}`);
			throw new Error("Refused unowned defaults proof destination");
		}
		const exchange = nativeFetch(request);
		nativeExchanges.add(exchange);
		try {
			const response = await exchange;
			const id = response.headers.get("x-defaults-proof-call");
			if (id !== null) {
				returnedBodies.add(Number(id));
			}
			return response;
		} catch (error) {
			transportErrors.push(
				`Native exchange ${request.method} ${request.url}: ${String(error)}`
			);
			throw error;
		} finally {
			nativeExchanges.delete(exchange);
			notifyTransportChange();
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			if (new URL(String(args[0])).origin !== server.url.origin) {
				unexpected.push(`Unowned preconnect ${String(args[0])}`);
				throw new Error("Refused unowned defaults proof preconnect");
			}
			return nativeFetch.preconnect(...args);
		},
	}
);
const previousBackend = process.env.VITE_APP_BACKEND_URL;
process.env.VITE_APP_BACKEND_URL = server.url.origin;
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useActiveNode } = await import("@/src/hooks/useActiveNode.ts");
const { toTarget } = await import("@/src/lib/api/client.ts");
const { nodeDefaultModelQueryKey, resolveNodeDefaultModel } = await import(
	"@/src/hooks/useNodeDefaultModel.ts"
);
const { getPreference, setLaneAgentSelection } = await import(
	"@/src/lib/api/preferences.ts"
);
const { BACKEND_URL, vaultHydrated, TOKEN_KEY } = await import(
	"@/lib/auth-client.ts"
);
const { DefaultsSection } = await import("./DefaultsSection.tsx");
const { AgentEvalsView } = await import(
	"@/src/components/agents/AgentEvalsView.tsx"
);
await vaultHydrated;
const originalNodeState = useNodeStore.getState();
const rootTransportStarts = new WeakMap<Root, number>();
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let showEvals = true;
let evalGeneration = 0;
let showFreshRefusalEvals = false;
const runtimeErrors: string[] = [];
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onUnhandledRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onUnhandledRejection);

function observedRoot(element: HTMLDivElement) {
	const mountedRoot = createRoot(element, {
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	rootTransportStarts.set(mountedRoot, nextCallId);
	return mountedRoot;
}

function MountedSettings() {
	const node = useActiveNode();
	const target: ApiTarget = toTarget(node);
	const [draft, setDraft] = useState("Unsent defaults proof draft");
	return (
		<>
			<input
				aria-label="Unsent defaults proof draft"
				onChange={(event) => setDraft(event.target.value)}
				value={draft}
			/>
			<DefaultsSection canConfigure managed={false} target={target} />
			{showEvals ? (
				<div data-defaults-proof-evals="automatic">
					<AgentEvalsView
						agentId={null}
						defaultModel=""
						key={evalGeneration}
						target={target}
					/>
				</div>
			) : null}
			{showFreshRefusalEvals ? (
				<div data-defaults-proof-evals="fresh">
					<AgentEvalsView agentId={null} defaultModel="" target={target} />
				</div>
			) : null}
		</>
	);
}
function tree() {
	return (
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<EntitlementProvider>
					<MountedSettings />
					<Toaster />
				</EntitlementProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
}
async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
function currentNode(
	token = "defaults-a-bearer",
	userJwt = "defaults-a-jwt"
): Node {
	return {
		name: "defaults-proof",
		url: `${server.url.origin}/node`,
		token,
		userJwt,
	};
}
async function setNode(node: Node) {
	await act(async () =>
		useNodeStore.setState({
			autoSelect: false,
			autoSelectedNode: null,
			defaultNode: node.name,
			nodes: [node],
		})
	);
}
function localControl() {
	const element = document.querySelector<HTMLButtonElement>(
		'[aria-label="Default local agent or model"]'
	);
	if (!element) {
		throw new Error("Missing actual local model setting");
	}
	return element;
}
function evalInput() {
	const element = container?.querySelector<HTMLInputElement>("#eval-model");
	if (!element) {
		throw new Error("Missing actual eval model consumer");
	}
	return element;
}
function draftInput() {
	const element = container?.querySelector<HTMLInputElement>(
		'[aria-label="Unsent defaults proof draft"]'
	);
	if (!element) {
		throw new Error("Missing retained draft");
	}
	return element;
}
function button(name: string) {
	const element = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(item) =>
			(item.getAttribute("aria-label") ?? item.textContent?.trim()) === name
	);
	if (!element) {
		throw new Error(`Missing actual action ${name}`);
	}
	return element;
}
async function chooseCustomModel(model: string) {
	await act(async () => localControl().click());
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') !== null,
		"Actual custom model field did not open"
	);
	const input = document.querySelector<HTMLInputElement>(
		'[aria-label="Custom model id"]'
	)!;
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, model);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () =>
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				bubbles: true,
				cancelable: true,
			})
		)
	);
}
async function mount() {
	expect(BACKEND_URL).toBe(server.url.origin);
	container = document.createElement("div");
	document.body.append(container);
	root = observedRoot(container);
	await act(async () => root!.render(tree()));
	await until(
		() =>
			document.querySelector('[aria-label="Default local agent or model"]') !==
				null &&
			calls.filter(
				(call) =>
					entitlementKeys.has(
						new URL(call.url).pathname.split("/").at(-1) ?? ""
					) && call.status === 200
			).length >= 2 &&
			activeHandlers === 0 &&
			evalInput().value === "model-a",
		"Actual saved defaults and model consumer did not finish initial reads"
	);
}
async function unmount() {
	const cleanupErrors: unknown[] = [];
	if (root) {
		const mountedRoot = root;
		const start = rootTransportStarts.get(mountedRoot);
		try {
			if (start === undefined) {
				throw new Error("Missing actual renderer transport start");
			}
			// This genuine provider publishes two mirrors sequentially after
			// becoming ready. Await both SDK-consumed HTTP acknowledgments before
			// ending its lifetime; an empty fetch set can precede the second call.
			await until(
				() =>
					[...entitlementKeys].every((key) =>
						calls.some(
							(call) =>
								call.id > start &&
								call.method === "PUT" &&
								new URL(call.url).pathname.endsWith(`/${key}`) &&
								call.status === 200 &&
								acknowledged(call)?.text === JSON.stringify({ ok: true, key })
						)
					),
				"Actual renderer entitlement mirrors did not consume both native acknowledgments"
			);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await act(async () => {
				mountedRoot.unmount();
				await settleNativeTransport();
			});
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	root = null;
	container?.remove();
	container = null;
	if (cleanupErrors.length) {
		throw new AggregateError(cleanupErrors, "Actual renderer teardown failed");
	}
}
async function newlyOpenEvals() {
	showEvals = false;
	await act(async () => root!.render(tree()));
	expect(container?.querySelector("#eval-model")).toBeNull();
	evalGeneration += 1;
	showEvals = true;
	await act(async () => root!.render(tree()));
}
function acknowledged(call: Call) {
	return bodyReads.find(
		(read) => read.id === call.id && read.status === call.status
	);
}
function localWrites() {
	return calls.filter(
		(call) =>
			call.method === "PUT" &&
			new URL(call.url).pathname.endsWith(`/${localKey}`)
	);
}
async function assertIndependentForeignDefault(expected: Records) {
	const target: ApiTarget = {
		url: `${server.url.origin}/foreign`,
		token: "defaults-foreign-bearer",
		userJwt: "defaults-foreign-jwt",
	};
	const before = calls.length;
	expect(await getPreference(target, localKey)).toBe(
		expected.foreign[localKey]
	);
	const read = calls
		.slice(before)
		.find((call) => call.url === `${target.url}/api/preferences/${localKey}`)!;
	expect(read).toMatchObject({
		owner: "foreign",
		method: "GET",
		bearer: "Bearer defaults-foreign-bearer",
		delegation: "defaults-foreign-jwt",
		body: null,
		status: 200,
	});
	expect(acknowledged(read)?.text).toBe(
		JSON.stringify({ key: localKey, value: expected.foreign[localKey] })
	);
}
async function assertActualEvalRequest(owner: Owner, model: string) {
	const before = calls.length;
	await act(async () => button("Run evals").click());
	await until(
		() =>
			calls
				.slice(before)
				.some(
					(call) =>
						call.url.endsWith("/api/gateway/evals/run") &&
						acknowledged(call) !== undefined
				),
		"Actual eval run did not consume its native HTTP refusal"
	);
	const run = calls
		.slice(before)
		.find((call) => call.url.endsWith("/api/gateway/evals/run"))!;
	expect(run).toMatchObject({
		owner,
		method: "POST",
		body: {
			agent_id: null,
			model,
			dataset: [],
			evaluators: [],
			code_evaluators: [],
		},
		status: 503,
	});
	expect(acknowledged(run)?.text).toBe(
		JSON.stringify({ error: "Owned inference provider unavailable" })
	);
	await until(
		() => container!.textContent!.includes("503"),
		"Actual eval error consumer did not render HTTP503"
	);
	expect(button("Run evals").disabled).toBe(false);
}
async function assertUnmountedQueries() {
	await unmount();
	const queries = queryClient.getQueryCache().findAll();
	expect(queries.every((query) => query.getObserversCount() === 0)).toBe(true);
	const before = calls.length;
	await act(async () => {
		await queryClient.invalidateQueries();
		await Bun.sleep(25);
	});
	expect(calls).toHaveLength(before);
	expect(activeHandlers).toBe(0);
	expect(runtimeErrors).toEqual([]);
}

beforeEach(async () => {
	await unmount();
	await settleNativeTransport();
	queryClient.clear();
	localStorage.clear();
	localStorage.setItem("ryu_client_id", "defaults-proof-client");
	localStorage.setItem("defaults-proof-unrelated", "preserved");
	localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
	records = { a: seed("model-a"), foreign: seed("foreign-model") };
	await persistRecords();
	calls.length = 0;
	bodyReads.length = 0;
	bodyReadStarts.length = 0;
	heldBodies.length = 0;
	holdLocalReadCredentials = null;
	refuseLocalReadCredentials = null;
	unexpected.length = 0;
	transportErrors.length = 0;
	runtimeErrors.length = 0;
	allowed.clear();
	allowed.set("Bearer defaults-a-bearer|defaults-a-jwt", "a");
	allowed.set("Bearer defaults-foreign-bearer|defaults-foreign-jwt", "foreign");
	refusedLocalWrites = 0;
	showEvals = true;
	evalGeneration = 0;
	showFreshRefusalEvals = false;
	await setNode(currentNode());
});
afterEach(async () => {
	try {
		await unmount();
		await settleNativeTransport();
		await until(
			() =>
				activeHandlers === 0 &&
				queryClient.isFetching() === 0 &&
				server.pendingRequests === 0 &&
				nativeExchanges.size === 0 &&
				nativeBodyObservations.size === 0 &&
				returnedBodies.size === 0,
			"Actual HTTP/query work outlived renderer teardown"
		);
		await persistence;
		expect(server.pendingRequests).toBe(0);
		expect(activeHandlers).toBe(0);
		expect(nativeExchanges.size).toBe(0);
		expect(nativeBodyObservations.size).toBe(0);
		expect([...returnedBodies]).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(runtimeErrors).toEqual([]);
		expect(transportErrors).toEqual([]);
		expect(
			bodyReads.every((read) => calls.some((call) => call.id === read.id))
		).toBe(true);
		queryClient.clear();
	} finally {
		if (diagnosticDirectory) {
			await mkdir(diagnosticDirectory, { recursive: true });
			await writeFile(
				join(diagnosticDirectory, `case-${++diagnosticCase}.json`),
				JSON.stringify(
					{
						calls,
						bodyReads,
						unexpected,
						runtimeErrors,
						transportErrors,
						activeHandlers,
						bodyReadStarts,
						heldBodies: heldBodySnapshot(),
						nativeExchanges: nativeExchanges.size,
						nativeBodyObservations: nativeBodyObservations.size,
						returnedBodies: [...returnedBodies],
						queryFetching: queryClient.isFetching(),
						queries: queryClient
							.getQueryCache()
							.findAll()
							.map((query) => ({
								key: query.queryKey,
								observers: query.getObserversCount(),
							})),
					},
					null,
					2
				)
			);
		}
	}
});
afterAll(async () => {
	const closureErrors: unknown[] = [];
	let serverStopAcknowledged = false;
	try {
		await settleNativeTransport();
	} catch (error) {
		closureErrors.push(error);
	}
	try {
		// The invocation-owned listener must close even when a real unread body
		// refuses settlement. Never restore global observers over a live server.
		await server.stop(true);
		serverStopAcknowledged = true;
	} catch (error) {
		closureErrors.push(error);
	}
	try {
		await Promise.allSettled([...nativeExchanges, ...nativeBodyObservations]);
		await persistence;
		expect(serverStopAcknowledged).toBe(true);
		expect(server.pendingRequests).toBe(0);
		expect(activeHandlers).toBe(0);
		expect(nativeExchanges.size).toBe(0);
		expect(nativeBodyObservations.size).toBe(0);
		expect([...returnedBodies]).toEqual([]);
		expect(runtimeErrors).toEqual([]);
		expect(transportErrors).toEqual([]);
	} catch (error) {
		closureErrors.push(error);
	}
	try {
		if (diagnosticDirectory) {
			await writeFile(
				join(diagnosticDirectory, "closure.json"),
				JSON.stringify(
					{
						serverStopAcknowledged,
						nativeServerPendingRequests: server.pendingRequests,
						activeHandlers,
						nativeExchanges: nativeExchanges.size,
						nativeBodyObservations: nativeBodyObservations.size,
						returnedBodies: [...returnedBodies],
						transportErrors,
						runtimeErrors,
						heldBodies: heldBodySnapshot(),
						closureErrors: closureErrors.map(String),
					},
					null,
					2
				)
			);
		}
	} catch (error) {
		closureErrors.push(error);
	}
	try {
		await rm(directory, { recursive: true });
	} catch (error) {
		closureErrors.push(error);
	}
	try {
		useNodeStore.setState(originalNodeState);
		window.removeEventListener("error", onError);
		window.removeEventListener("unhandledrejection", onUnhandledRejection);
		NativeResponse.prototype.text = nativeResponseText;
		globalThis.fetch = nativeFetch;
		if (previousBackend === undefined) {
			delete process.env.VITE_APP_BACKEND_URL;
		} else {
			process.env.VITE_APP_BACKEND_URL = previousBackend;
		}
		if (previousActFlag) {
			Object.defineProperty(
				globalThis,
				"IS_REACT_ACT_ENVIRONMENT",
				previousActFlag
			);
		} else {
			Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		}
		if (registeredAbortController) {
			Object.defineProperty(
				globalThis,
				"AbortController",
				registeredAbortController
			);
		} else {
			Reflect.deleteProperty(globalThis, "AbortController");
		}
		if (registeredAbortSignal) {
			Object.defineProperty(globalThis, "AbortSignal", registeredAbortSignal);
		} else {
			Reflect.deleteProperty(globalThis, "AbortSignal");
		}
		if (ownsDom) {
			await GlobalRegistrator.unregister();
		}
	} catch (error) {
		closureErrors.push(error);
	}
	if (closureErrors.length) {
		throw new AggregateError(
			closureErrors,
			"Actual Defaults proof closure failed"
		);
	}
});

test("actual local-default keyboard save conserves refused state, retries durably and feeds a newly opened eval consumer", async () => {
	await mount();
	const original = await independentlyReadRecords();
	await assertIndependentForeignDefault(original);
	const draft = draftInput();
	refusedLocalWrites = 1;
	await chooseCustomModel("model-next");
	await until(
		() =>
			localWrites().length === 1 &&
			acknowledged(localWrites()[0]!) !== undefined &&
			!localControl().disabled,
		"Refused actual default write did not settle"
	);
	expect(localWrites()[0]).toMatchObject({
		owner: "a",
		bearer: "Bearer defaults-a-bearer",
		delegation: "defaults-a-jwt",
		body: { value: JSON.stringify(selection("model-next")) },
		status: 503,
	});
	expect(acknowledged(localWrites()[0]!)?.text).toBe(
		JSON.stringify({ error: "Owned preference write refused" })
	);
	expect(await independentlyReadRecords()).toEqual(original);
	expect(localControl().textContent).toContain("model-a");
	expect(evalInput().value).toBe("model-a");
	await until(
		() => document.body.textContent!.includes("Couldn't save the default"),
		"Real Toaster did not explain the refused save"
	);
	await chooseCustomModel("model-next");
	await until(
		() =>
			localWrites().length === 2 &&
			acknowledged(localWrites()[1]!) !== undefined &&
			!localControl().disabled,
		"Retry did not consume its actual native acknowledgment"
	);
	expect(localWrites()[1]).toMatchObject({
		owner: "a",
		body: { value: JSON.stringify(selection("model-next")) },
		status: 200,
	});
	expect(acknowledged(localWrites()[1]!)?.text).toBe(
		JSON.stringify({ ok: true, key: localKey })
	);
	expect(await independentlyReadRecords()).toEqual({
		...original,
		a: { ...original.a, [localKey]: JSON.stringify(selection("model-next")) },
	});
	expect(localControl().textContent).toContain("model-next");
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Unsent defaults proof draft");
	await newlyOpenEvals();
	await until(
		() => evalInput().value === "model-next",
		"An acknowledged local default was hidden by the old model query cache"
	);
	await assertActualEvalRequest("a", "model-next");
	expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	await assertUnmountedQueries();
	// A fresh renderer with an independent cache reads the file-backed peer again.
	queryClient.clear();
	const saved = await independentlyReadRecords();
	expect(saved.a[localKey]).toBe(JSON.stringify(selection("model-next")));
	showEvals = false;
	container = document.createElement("div");
	document.body.append(container);
	root = observedRoot(container);
	await act(async () => root!.render(tree()));
	await until(
		() =>
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-next") === true,
		"Independent settings remount did not read the acknowledged saved model"
	);
	expect(await independentlyReadRecords()).toEqual(saved);
});

for (const credential of ["Bearer", "JWT"] as const) {
	test(`same-URL ${credential}-only authority change rereads the acknowledged node default and transports it from the actual eval consumer`, async () => {
		await mount();
		const original = await independentlyReadRecords();
		await assertIndependentForeignDefault(original);
		const draft = draftInput();
		draft.focus();
		// Core preferences belong to the node. A genuine independent SDK writer
		// updates that one node before credentials rotate; there is no fabricated
		// per-user preference namespace at the same URL.
		const beforeExternalWrite = calls.length;
		await act(async () => {
			expect(
				await setLaneAgentSelection(
					toTarget(currentNode()),
					"local",
					selection("model-b")
				)
			).toBe(true);
		});
		const externalWrite = calls
			.slice(beforeExternalWrite)
			.find(
				(call) => call.method === "PUT" && call.url.endsWith(`/${localKey}`)
			);
		expect(externalWrite).toBeDefined();
		expect(externalWrite).toMatchObject({
			owner: "a",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: { value: JSON.stringify(selection("model-b")) },
			status: 200,
		});
		expect(acknowledged(externalWrite!)?.text).toBe(
			JSON.stringify({ ok: true, key: localKey })
		);
		const updated = {
			...original,
			a: { ...original.a, [localKey]: JSON.stringify(selection("model-b")) },
		};
		expect(await independentlyReadRecords()).toEqual(updated);
		const node =
			credential === "Bearer"
				? currentNode("defaults-b-bearer", "defaults-a-jwt")
				: currentNode("defaults-a-bearer", "defaults-b-jwt");
		allowed.set(`Bearer ${node.token}|${node.userJwt}`, "a");
		const before = calls.length;
		await setNode(node);
		await until(
			() =>
				document
					.querySelector('[aria-label="Default local agent or model"]')
					?.textContent?.includes("model-b") === true,
			"Actual setting did not reread the node's saved default under new credentials"
		);
		expect(draftInput()).toBe(draft);
		expect(document.activeElement).toBe(draft);
		expect(draft.value).toBe("Unsent defaults proof draft");
		await until(
			() => evalInput().value === "model-b",
			`The actual eval model cache reused the old ${credential} authority`
		);
		const reads = calls
			.slice(before)
			.filter((call) => new URL(call.url).pathname.endsWith(`/${localKey}`));
		// One read belongs to the real settings producer, the other to the real
		// model query. A refreshed old-credential cache is not new admission.
		expect(reads).toHaveLength(2);
		for (const read of reads) {
			expect(read).toMatchObject({
				owner: "a",
				method: "GET",
				bearer: `Bearer ${node.token}`,
				delegation: node.userJwt,
				body: null,
				status: 200,
			});
			expect(acknowledged(read)?.text).toBe(
				JSON.stringify({ key: localKey, value: updated.a[localKey] })
			);
		}
		await assertActualEvalRequest("a", "model-b");
		const run = [...calls]
			.reverse()
			.find((call) => call.url.endsWith("/api/gateway/evals/run"));
		expect(run).toMatchObject({
			bearer: `Bearer ${node.token}`,
			delegation: node.userJwt,
		});
		expect(localWrites()).toEqual([externalWrite!]);
		expect(await independentlyReadRecords()).toEqual(updated);
		expect(useNodeStore.getState().getActiveNode()).toEqual(node);
		expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
		expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
		await assertUnmountedQueries();
	});
}

test("returning to cached credentials after an acknowledged node-wide default save waits for actual response bodies before a fresh eval can run", async () => {
	await mount();
	const original = await independentlyReadRecords();
	const foreignTarget: ApiTarget = {
		url: `${server.url.origin}/foreign`,
		token: "defaults-foreign-bearer",
		userJwt: "defaults-foreign-jwt",
	};
	const foreignKey = nodeDefaultModelQueryKey(foreignTarget);
	expect(
		await queryClient.fetchQuery<NodeDefaultModel>({
			queryKey: foreignKey,
			queryFn: () => resolveNodeDefaultModel(foreignTarget),
			staleTime: 60 * 1000,
		})
	).toEqual({ agentId: undefined, model: "foreign-model" });
	const foreignReads = calls.filter((call) => call.owner === "foreign");
	expect(foreignReads).toHaveLength(1);
	expect(foreignReads[0]).toMatchObject({
		method: "GET",
		bearer: "Bearer defaults-foreign-bearer",
		delegation: "defaults-foreign-jwt",
		url: `${foreignTarget.url}/api/preferences/${localKey}`,
		body: null,
		status: 200,
	});
	expect(acknowledged(foreignReads[0]!)?.text).toBe(
		JSON.stringify({ key: localKey, value: original.foreign[localKey] })
	);
	const foreignCache = () => {
		const state = queryClient.getQueryState(foreignKey);
		if (!state) {
			throw new Error("Missing genuinely fetched foreign default cache");
		}
		return {
			data: state.data,
			dataUpdatedAt: state.dataUpdatedAt,
			isInvalidated: state.isInvalidated,
			status: state.status,
			fetchStatus: state.fetchStatus,
		};
	};
	const foreignCacheBefore = foreignCache();
	const nodeA = currentNode();
	const cachedA = queryClient.getQueryState(
		nodeDefaultModelQueryKey(toTarget(nodeA))
	);
	expect(cachedA?.data).toEqual({ agentId: undefined, model: "model-a" });
	expect(cachedA?.status).toBe("success");
	expect(cachedA?.isInvalidated).toBe(false);
	const cachedAUpdatedAt = cachedA!.dataUpdatedAt;
	const draft = draftInput();
	const nodeB = currentNode("defaults-b-bearer", "defaults-a-jwt");
	allowed.set(`Bearer ${nodeB.token}|${nodeB.userJwt}`, "a");
	await setNode(nodeB);
	await until(
		() =>
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-a") === true &&
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeB)))
				?.status === "success",
		"New credentials did not genuinely read the same node-wide starting model"
	);
	await chooseCustomModel("model-b");
	await until(
		() =>
			localWrites().length === 1 &&
			acknowledged(localWrites()[0]!) !== undefined &&
			!localControl().disabled &&
			evalInput().value === "model-b",
		"The real B producer save did not acknowledge and refresh its model consumer"
	);
	const save = localWrites()[0]!;
	expect(save).toMatchObject({
		owner: "a",
		bearer: `Bearer ${nodeB.token}`,
		delegation: nodeB.userJwt,
		body: { value: JSON.stringify(selection("model-b")) },
		status: 200,
	});
	expect(acknowledged(save)?.text).toBe(
		JSON.stringify({ ok: true, key: localKey })
	);
	const saved = {
		...original,
		a: { ...original.a, [localKey]: JSON.stringify(selection("model-b")) },
	};
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);

	// Only reopen the genuine eval consumer. The real shared query cache and
	// mounted surrounding draft remain, including A's recent cached model-a.
	showEvals = false;
	await act(async () => root!.render(tree()));
	expect(container?.querySelector("#eval-model")).toBeNull();
	draft.focus();
	holdLocalReadCredentials = {
		bearer: "Bearer defaults-a-bearer",
		delegation: "defaults-a-jwt",
	};
	const beforeReturn = calls.length;
	evalGeneration += 1;
	showEvals = true;
	try {
		expect(Date.now() - cachedAUpdatedAt).toBeLessThan(60 * 1000);
		await setNode(nodeA);
		await act(async () => root!.render(tree()));
		await until(
			() =>
				heldBodies.length === 2 &&
				heldBodies.every((body) => bodyReadStarts.includes(body.id)),
			"Returning A did not start both genuine producer and model-query reads before using its cached default"
		);
		const returningReads = calls
			.slice(beforeReturn)
			.filter((call) => new URL(call.url).pathname.endsWith(`/${localKey}`));
		expect(returningReads).toHaveLength(2);
		for (const read of returningReads) {
			expect(read).toMatchObject({
				owner: "a",
				method: "GET",
				bearer: "Bearer defaults-a-bearer",
				delegation: "defaults-a-jwt",
				body: null,
				status: 200,
			});
			expect(bodyReadStarts).toContain(read.id);
			expect(acknowledged(read)).toBeUndefined();
		}
		expect(
			[...heldBodySnapshot()].sort((left, right) => left.id - right.id)
		).toEqual(
			[
				...returningReads.map((read) => ({
					id: read.id,
					text: JSON.stringify({ key: localKey, value: saved.a[localKey] }),
					released: false,
					cancelled: null,
				})),
			].sort((left, right) => left.id - right.id)
		);
		expect(
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeA)))
				?.fetchStatus
		).toBe("fetching");
		expect(evalInput().value).toBe("");
		expect(button("Run evals").disabled).toBe(true);
		await act(async () => button("Run evals").click());
		expect(
			calls.some((call) => call.url.endsWith("/api/gateway/evals/run"))
		).toBe(false);
		expect(draftInput()).toBe(draft);
		expect(document.activeElement).toBe(draft);
		expect(draft.value).toBe("Unsent defaults proof draft");
		expect(foreignCache()).toEqual(foreignCacheBefore);
		expect(calls.filter((call) => call.owner === "foreign")).toEqual(
			foreignReads
		);
		expect(await independentlyReadRecords()).toEqual(saved);

		await act(async () => {
			releaseHeldBodies();
			await settleNativeTransport();
		});
		await until(
			() =>
				returningReads.every((read) => acknowledged(read) !== undefined) &&
				evalInput().value === "model-b" &&
				localControl().textContent?.includes("model-b") === true,
			"The fresh actual consumer did not follow the acknowledged held node-wide default"
		);
		for (const read of returningReads) {
			expect(acknowledged(read)?.text).toBe(
				JSON.stringify({ key: localKey, value: saved.a[localKey] })
			);
		}
		expect(
			heldBodies.every((body) => body.released && body.cancelled === null)
		).toBe(true);
		await assertActualEvalRequest("a", "model-b");
		expect(
			[...calls]
				.reverse()
				.find((call) => call.url.endsWith("/api/gateway/evals/run"))
		).toMatchObject({
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
		});
		expect(localWrites()).toEqual([save]);
		expect(foreignCache()).toEqual(foreignCacheBefore);
		expect(calls.filter((call) => call.owner === "foreign")).toEqual(
			foreignReads
		);
		expect(await independentlyReadRecords()).toEqual(saved);
		expect(draftInput()).toBe(draft);
		expect(document.activeElement).toBe(draft);
		expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
		expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
		expect(useNodeStore.getState().getActiveNode()).toEqual(nodeA);
	} finally {
		// An authentic baseline failure must still release its real network
		// bodies and await decoders before afterEach restores or resets anything.
		await act(async () => {
			releaseHeldBodies();
			await settleNativeTransport();
		});
	}
	await assertUnmountedQueries();
});

test("refused returning-credential reads retire both open and fresh automatic eval models until the real Defaults Retry acknowledges recovery", async () => {
	await mount();
	const original = await independentlyReadRecords();
	const foreignTarget: ApiTarget = {
		url: `${server.url.origin}/foreign`,
		token: "defaults-foreign-bearer",
		userJwt: "defaults-foreign-jwt",
	};
	const foreignKey = nodeDefaultModelQueryKey(foreignTarget);
	expect(
		await queryClient.fetchQuery<NodeDefaultModel>({
			queryKey: foreignKey,
			queryFn: () => resolveNodeDefaultModel(foreignTarget),
			staleTime: 60 * 1000,
		})
	).toEqual({ agentId: undefined, model: "foreign-model" });
	const foreignReads = calls.filter((call) => call.owner === "foreign");
	expect(foreignReads).toHaveLength(1);
	expect(foreignReads[0]).toMatchObject({
		method: "GET",
		bearer: "Bearer defaults-foreign-bearer",
		delegation: "defaults-foreign-jwt",
		url: `${foreignTarget.url}/api/preferences/${localKey}`,
		body: null,
		status: 200,
	});
	expect(acknowledged(foreignReads[0]!)?.text).toBe(
		JSON.stringify({ key: localKey, value: original.foreign[localKey] })
	);
	const foreignCache = () => {
		const state = queryClient.getQueryState(foreignKey);
		if (!state) {
			throw new Error("Missing genuinely fetched foreign refusal-proof cache");
		}
		return {
			data: state.data,
			dataUpdatedAt: state.dataUpdatedAt,
			isInvalidated: state.isInvalidated,
			status: state.status,
			fetchStatus: state.fetchStatus,
		};
	};
	const foreignCacheBefore = foreignCache();
	const nodeA = currentNode();
	const keyA = nodeDefaultModelQueryKey(toTarget(nodeA));
	const cachedA = queryClient.getQueryState(keyA);
	expect(cachedA?.data).toEqual({ agentId: undefined, model: "model-a" });
	expect(cachedA?.status).toBe("success");
	expect(cachedA?.isInvalidated).toBe(false);
	const cachedAUpdatedAt = cachedA!.dataUpdatedAt;
	const automaticInput = evalInput();
	const draft = draftInput();
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(draft, "Edited refusal proof draft");
		draft.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const nodeB = currentNode("defaults-b-bearer", "defaults-a-jwt");
	allowed.set(`Bearer ${nodeB.token}|${nodeB.userJwt}`, "a");
	await setNode(nodeB);
	await until(
		() =>
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-a") === true &&
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeB)))
				?.status === "success",
		"New credentials did not acknowledge the node-wide starting default before the refusal proof"
	);
	await chooseCustomModel("model-b");
	await until(
		() =>
			localWrites().length === 1 &&
			acknowledged(localWrites()[0]!) !== undefined &&
			!localControl().disabled &&
			automaticInput.value === "model-b" &&
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeB)))
				?.fetchStatus === "idle",
		"The actual B save did not acknowledge and refresh the already-open automatic consumer"
	);
	const save = localWrites()[0]!;
	expect(save).toMatchObject({
		owner: "a",
		bearer: `Bearer ${nodeB.token}`,
		delegation: nodeB.userJwt,
		body: { value: JSON.stringify(selection("model-b")) },
		status: 200,
	});
	expect(acknowledged(save)?.text).toBe(
		JSON.stringify({ ok: true, key: localKey })
	);
	const saved = {
		...original,
		a: { ...original.a, [localKey]: JSON.stringify(selection("model-b")) },
	};
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(evalInput()).toBe(automaticInput);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);

	// The original automatic field stays mounted and unedited. A second real
	// consumer starts on return A; both observe the same genuine QueryClient.
	// Actual failed HTTP bodies, rather than a fabricated empty/default DTO,
	// must settle the installed retry1 before either field can run.
	draft.focus();
	refuseLocalReadCredentials = {
		bearer: "Bearer defaults-a-bearer",
		delegation: "defaults-a-jwt",
	};
	showFreshRefusalEvals = true;
	const beforeReturn = calls.length;
	expect(Date.now() - cachedAUpdatedAt).toBeLessThan(60 * 1000);
	await setNode(nodeA);
	const refusedReads = () =>
		calls
			.slice(beforeReturn)
			.filter(
				(call) =>
					call.method === "GET" &&
					new URL(call.url).pathname.endsWith(`/${localKey}`)
			);
	await until(
		() =>
			refusedReads().length === 3 &&
			refusedReads().every((call) => acknowledged(call) !== undefined) &&
			queryClient.getQueryState(keyA)?.status === "error" &&
			queryClient.getQueryState(keyA)?.fetchStatus === "idle" &&
			container?.textContent?.includes(
				"Could not load the saved defaults. Retry before making changes."
			) === true,
		"The actual producer and both installed query retry attempts did not consume their native HTTP503 refusals"
	);
	const failures = refusedReads();
	expect(failures).toHaveLength(3);
	for (const read of failures) {
		expect(read).toMatchObject({
			owner: "a",
			method: "GET",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: null,
			status: 503,
		});
		expect(bodyReadStarts).toContain(read.id);
		expect(acknowledged(read)?.text).toBe(
			JSON.stringify({ error: "Owned preference read refused" })
		);
	}
	const consumers = () =>
		(["automatic", "fresh"] as const).map((name) => {
			const view = container?.querySelector<HTMLDivElement>(
				`[data-defaults-proof-evals="${name}"]`
			);
			const input = view?.querySelector<HTMLInputElement>("#eval-model");
			const run = [
				...(view?.querySelectorAll<HTMLButtonElement>("button") ?? []),
			].find((item) => item.textContent?.trim() === "Run evals");
			if (!(view && input && run)) {
				throw new Error(`Missing actual ${name} refusal-proof eval consumer`);
			}
			return { view, input, run };
		});
	expect(evalInput()).toBe(automaticInput);
	expect(consumers().map(({ input }) => input.value)).toEqual(["", ""]);
	expect(consumers().map(({ run }) => run.disabled)).toEqual([true, true]);
	await act(async () => {
		for (const { run } of consumers()) {
			run.click();
		}
	});
	expect(
		calls.some((call) => call.url.endsWith("/api/gateway/evals/run"))
	).toBe(false);
	expect(
		document.querySelector('[aria-label="Default local agent or model"]')
	).toBeNull();
	expect(button("Retry").disabled).toBe(false);
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Edited refusal proof draft");
	expect(document.activeElement).toBe(draft);
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);

	refuseLocalReadCredentials = null;
	const beforeRetry = calls.length;
	await act(async () => button("Retry").click());
	const recoveryReads = () =>
		calls
			.slice(beforeRetry)
			.filter(
				(call) =>
					call.method === "GET" &&
					new URL(call.url).pathname.endsWith(`/${localKey}`)
			);
	await until(
		() =>
			recoveryReads().length === 2 &&
			recoveryReads().every((call) => acknowledged(call) !== undefined) &&
			queryClient.getQueryState(keyA)?.status === "success" &&
			queryClient.getQueryState(keyA)?.fetchStatus === "idle" &&
			consumers().every(
				({ input, run }) => input.value === "model-b" && !run.disabled
			) &&
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-b") === true,
		"The real Defaults Retry did not acknowledge both stored defaults and the recovered automatic-model query"
	);
	expect(recoveryReads()).toHaveLength(2);
	for (const read of recoveryReads()) {
		expect(read).toMatchObject({
			owner: "a",
			method: "GET",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: null,
			status: 200,
		});
		expect(acknowledged(read)?.text).toBe(
			JSON.stringify({ key: localKey, value: saved.a[localKey] })
		);
	}
	expect(container?.textContent).not.toContain(
		"Could not load the saved defaults. Retry before making changes."
	);
	expect(evalInput()).toBe(automaticInput);
	for (const { view, run } of consumers()) {
		const beforeRun = calls.length;
		await act(async () => run.click());
		await until(
			() =>
				calls
					.slice(beforeRun)
					.some(
						(call) =>
							call.url.endsWith("/api/gateway/evals/run") &&
							acknowledged(call) !== undefined
					),
			"Recovered actual eval consumer did not consume its native inference refusal"
		);
		const request = calls
			.slice(beforeRun)
			.find((call) => call.url.endsWith("/api/gateway/evals/run"))!;
		expect(request).toMatchObject({
			owner: "a",
			method: "POST",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: {
				agent_id: null,
				model: "model-b",
				dataset: [],
				evaluators: [],
				code_evaluators: [],
			},
			status: 503,
		});
		expect(acknowledged(request)?.text).toBe(
			JSON.stringify({ error: "Owned inference provider unavailable" })
		);
		await until(
			() => view.textContent?.includes("503") === true && !run.disabled,
			"That actual recovered eval consumer did not render its acknowledged HTTP503 error and permit retry"
		);
	}
	await until(
		() =>
			consumers().every(
				({ input, run }) => input.value === "model-b" && !run.disabled
			),
		"Actual eval refusal did not leave both recovered consumers available for retry"
	);
	expect(localWrites()).toEqual([save]);
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Edited refusal proof draft");
	expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	expect(useNodeStore.getState().getActiveNode()).toEqual(nodeA);
	await assertUnmountedQueries();
});
