import { afterEach, expect, test } from "bun:test";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const native = {
	fetch: globalThis.fetch,
	Response: globalThis.Response,
	Request: globalThis.Request,
	Headers: globalThis.Headers,
	AbortController: globalThis.AbortController,
	AbortSignal: globalThis.AbortSignal,
};
const nativeResponseText = native.Response.prototype.text;
const nativeResponseJson = native.Response.prototype.json;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Object.assign(globalThis, native);
const NativeResponse = native.Response;
const NativeRequest = native.Request;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useApps } = await import("./useApps.ts");
const { useNodeStore } = await import("../store/useNodeStore.ts");
const { queryClient } = await import("../lib/query-client.ts");
const { QueryClientProvider } = await import("@tanstack/react-query");
const previousNodes = useNodeStore.getState();
let latest: ReturnType<typeof useApps>;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
let dispose: (() => Promise<void>) | undefined;
let settleBeforeUnmount: (() => Promise<void>) | undefined;
let runtimeErrors: string[] = [];
let fixtureReceiptId = 0;
function Consumer() {
	latest = useApps();
	return createElement(
		"output",
		null,
		JSON.stringify({
			apps: latest.apps.map(({ id, name, enabled }) => ({ id, name, enabled })),
			error: latest.toggleError,
		})
	);
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(Consumer)
			)
		)
	);
}
async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	throw new Error("App roster consumer did not acknowledge the operation");
}
afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	try {
		await settleBeforeUnmount?.();
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await act(async () => root?.unmount());
	} catch (error) {
		cleanupErrors.push(error);
	}
	root = undefined;
	container?.remove();
	container = undefined;
	try {
		await queryClient.cancelQueries();
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await dispose?.();
	} catch (error) {
		cleanupErrors.push(error);
	} finally {
		dispose = undefined;
		settleBeforeUnmount = undefined;
		queryClient.clear();
		useNodeStore.setState(previousNodes);
	}
	if (cleanupErrors.length) {
		throw new AggregateError(
			cleanupErrors,
			"Actual mounted consumer cleanup failed"
		);
	}
});
function fixture() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "ryu-app-roster-"));
	dispose = async () => rmSync(directory, { recursive: true, force: true });
	type Authority = "a" | "b";
	const record = (authority: Authority, id: string) => ({
		id,
		name: `${id} ${authority}`,
		built_in: false,
		enabled: true,
		installed: true,
		installed_version: "1.0.0",
		version: "1.0.0",
		local_only: false,
		windows_first: false,
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
	});
	type Record = ReturnType<typeof record>;
	const raw = (authority: Authority) =>
		readFileSync(path.join(directory, `${authority}.json`), "utf8");
	const read = (authority: Authority): Record[] => JSON.parse(raw(authority));
	const store = (authority: Authority, records: Record[]) => {
		const file = path.join(directory, `${authority}.json`);
		writeFileSync(`${file}.new`, JSON.stringify(records));
		const fd = openSync(`${file}.new`, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(`${file}.new`, file);
		const parent = openSync(directory, "r");
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	};
	store("a", [record("a", "shared"), record("a", "unrelated")]);
	store("b", [record("b", "shared"), record("b", "unrelated")]);
	let heldA = false;
	let releaseA: (() => void) | undefined;
	let refuseB = false;
	const mutations: {
		authority: Authority;
		method: string;
		path: string;
		admitted: boolean;
	}[] = [];
	let peerOrigin = "";
	const unknownRequests: Array<{
		method: string;
		url: string;
		problem: string;
	}> = [];
	const peerErrors: string[] = [];
	runtimeErrors = [];
	const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
	const onUnhandledRejection = (event: PromiseRejectionEvent) =>
		runtimeErrors.push(String(event.reason));
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onUnhandledRejection);
	const refuseUnknown = (request: Request, problem: string) => {
		unknownRequests.push({ method: request.method, url: request.url, problem });
		return NativeResponse.json({ error: problem }, { status: 400 });
	};
	const validateHeaders = (request: Request): string | null => {
		const clientId = localStorage.getItem("ryu_client_id");
		if (!clientId || request.headers.get("x-ryu-client-id") !== clientId) {
			return "Wrong or missing persisted Desktop client identity";
		}
		if (
			request.headers.get("content-type") !== "application/json" ||
			request.headers.get("x-ryu-client-label") !== "Desktop" ||
			request.headers.get("x-ryu-surface") !== "desktop" ||
			request.headers.has("cookie") ||
			request.headers.has("origin")
		) {
			return "Unexpected native transport or Desktop identity headers";
		}
		const identityNames = [...request.headers.keys()]
			.filter((name) => name.startsWith("x-ryu-"))
			.sort();
		if (
			JSON.stringify(identityNames) !==
			JSON.stringify(["x-ryu-client-id", "x-ryu-client-label", "x-ryu-surface"])
		) {
			return "Undeclared delegation, buyer or attribution header";
		}
		if (
			!["Bearer token-a", "Bearer token-b"].includes(
				request.headers.get("authorization") ?? ""
			)
		) {
			return "Undeclared node admission credential";
		}
		return null;
	};
	let nextRequestId = 0;
	const activeHandlers = new Set<number>();
	const handlerReceipts: Array<{
		id: number;
		url: string;
		method: string;
		authorization: string | null;
		terminal: boolean;
	}> = [];
	const cancellations: Array<{
		id: number | null;
		url: string;
		method: string;
		authorization: string | null;
		stage: "exchange" | "body";
		nativeErrorName: "AbortError";
		suppliedSignalAborted: true;
		requestSignalAborted: true;
	}> = [];
	const isNativeAbort = (error: unknown): boolean =>
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError";
	const nativeExchanges = new Set<Promise<Response>>();
	const bodyObservations = new Set<Promise<unknown>>();
	const unreadBodies = new Set<number>();
	const bodyReceipts: Array<{
		id: number;
		status: number;
		method: "text" | "json";
		body: unknown;
	}> = [];
	const transportErrors: string[] = [];
	const transportChanged = new Set<() => void>();
	const changed = () => {
		for (const notify of transportChanged) {
			notify();
		}
	};
	const unsubscribeQuery = queryClient.getQueryCache().subscribe(changed);
	const counters = () => ({
		activeHandlers: activeHandlers.size,
		nativeExchanges: nativeExchanges.size,
		bodyObservations: bodyObservations.size,
		unreadBodies: [...unreadBodies],
		queryFetching: queryClient.isFetching(),
		queryObservers: queryClient
			.getQueryCache()
			.findAll()
			.reduce((sum, query) => sum + query.getObserversCount(), 0),
	});
	const idle = () =>
		activeHandlers.size === 0 &&
		nativeExchanges.size === 0 &&
		bodyObservations.size === 0 &&
		unreadBodies.size === 0 &&
		queryClient.isFetching() === 0;
	async function settleNativeTransport() {
		if (idle()) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				if (!idle()) {
					return;
				}
				transportChanged.delete(finish);
				nativeClearTimeout(deadline);
				resolve();
			};
			const deadline = nativeSetTimeout(() => {
				transportChanged.delete(finish);
				reject(
					new Error(
						`Owned native transport did not settle: ${JSON.stringify(counters())}`
					)
				);
			}, 3000);
			transportChanged.add(finish);
			finish();
		});
	}
	const observedFetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			let request: Request;
			try {
				request = new NativeRequest(input, init);
			} catch (error) {
				transportErrors.push(`Native Request construction: ${String(error)}`);
				throw error;
			}
			const url = new URL(request.url);
			const roster = url.pathname.match(/^\/(a|b)\/api\/plugins$/);
			const ownedQuery =
				roster !== null &&
				request.method === "GET" &&
				init?.signal != null &&
				queryClient.getQueryCache().find({
					queryKey: [
						"desktop-app-roster",
						`${peerOrigin}/${roster[1]}`,
						`token-${roster[1]}`,
						null,
					],
					exact: true,
				}) !== undefined;
			const acknowledgeCancellation = (
				error: unknown,
				stage: "exchange" | "body",
				id: number | null
			) => {
				if (
					!(ownedQuery && isNativeAbort(error)) ||
					init?.signal?.aborted !== true ||
					request.signal.aborted !== true
				) {
					return false;
				}
				cancellations.push({
					id,
					url: request.url,
					method: request.method,
					authorization: request.headers.get("authorization"),
					stage,
					nativeErrorName: "AbortError",
					suppliedSignalAborted: true,
					requestSignalAborted: true,
				});
				return true;
			};
			if (url.origin !== peerOrigin) {
				refuseUnknown(request, "Unowned native fetch destination");
				throw new Error("Refused unowned native peer destination");
			}
			let exchange: Promise<Response> | undefined;
			try {
				exchange = native.fetch(request);
				nativeExchanges.add(exchange);
				const response = await exchange;
				const encodedId = response.headers.get("x-ryu-native-peer-call");
				const id = Number(encodedId);
				if (encodedId === null || !Number.isInteger(id) || id < 1) {
					throw new Error("Native peer returned no actual request identity");
				}
				unreadBodies.add(id);
				const observeBody = <T,>(
					method: "text" | "json",
					read: () => Promise<T>
				): Promise<T> => {
					const observation = read();
					bodyObservations.add(observation);
					const complete = () => {
						bodyObservations.delete(observation);
						unreadBodies.delete(id);
						changed();
					};
					void observation.then(
						(body) => {
							bodyReceipts.push({ id, status: response.status, method, body });
							complete();
						},
						(error: unknown) => {
							if (!acknowledgeCancellation(error, "body", id)) {
								transportErrors.push(
									`Native response body ${id}: ${String(error)}`
								);
							}
							complete();
						}
					);
					return observation;
				};
				Object.defineProperties(response, {
					text: {
						value: () =>
							observeBody("text", () => nativeResponseText.call(response)),
					},
					json: {
						value: () =>
							observeBody("json", () => nativeResponseJson.call(response)),
					},
				});
				return response;
			} catch (error) {
				if (!acknowledgeCancellation(error, "exchange", null)) {
					transportErrors.push(
						`Native exchange ${request.method} ${request.url}: ${String(error)}`
					);
				}
				throw error;
			} finally {
				if (exchange) {
					nativeExchanges.delete(exchange);
				}
				changed();
			}
		},
		{
			preconnect: (...args: Parameters<typeof native.fetch.preconnect>) => {
				if (new URL(String(args[0])).origin !== peerOrigin) {
					unknownRequests.push({
						method: "PRECONNECT",
						url: String(args[0]),
						problem: "Unowned preconnect",
					});
					throw new Error("Refused unowned native peer preconnect");
				}
				return native.fetch.preconnect(...args);
			},
		}
	);
	async function handleRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(
			/^\/(a|b)(\/api\/plugins(?:\/shared\/(?:enable|disable))?)$/
		);
		if (url.origin !== peerOrigin || url.search || !match) {
			return refuseUnknown(
				request,
				"Undeclared plugin authority, path or query"
			);
		}
		const endpoint = match[2];
		if (
			(endpoint === "/api/plugins" && request.method !== "GET") ||
			(endpoint !== "/api/plugins" && request.method !== "POST")
		) {
			return refuseUnknown(request, "Undeclared plugin request method");
		}
		const headerProblem = validateHeaders(request);
		if (headerProblem) {
			return refuseUnknown(request, headerProblem);
		}
		if ((await request.text()) !== "") {
			return refuseUnknown(
				request,
				"Roster and selected lifecycle requests must have no body"
			);
		}
		const authority = match[1] as Authority;
		if (request.headers.get("authorization") !== `Bearer token-${authority}`) {
			return new NativeResponse(null, { status: 401 });
		}
		if (endpoint === "/api/plugins") {
			return NativeResponse.json({ apps: read(authority) });
		}
		const call = {
			authority,
			method: request.method,
			path: endpoint,
			admitted: false,
		};
		mutations.push(call);
		if (authority === "a" && heldA) {
			heldA = false;
			await new Promise<void>((resolve) => {
				releaseA = resolve;
			});
			return NativeResponse.json(
				{ reason: "A mutation refused" },
				{ status: 503 }
			);
		}
		if (authority === "b" && refuseB) {
			return NativeResponse.json(
				{ reason: "B mutation refused" },
				{ status: 503 }
			);
		}
		const records = read(authority);
		const selected = records[0];
		if (selected?.id !== "shared") {
			throw new Error("Missing selected fixture app");
		}
		selected.enabled = endpoint.endsWith("/enable");
		store(authority, records);
		call.admitted = true;
		const app = {
			id: selected.id,
			version: selected.version,
			enabled: selected.enabled,
			approved_grants: [],
			channel: "stable",
			provenance: null,
			created_at: null,
			updated_at: null,
		};
		return NativeResponse.json(
			selected.enabled
				? { success: true, app, runnables: [], enabled_dependencies: [] }
				: { success: true, app, disabled: [selected.id] }
		);
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const id = ++nextRequestId;
			activeHandlers.add(id);
			const receipt = {
				id,
				url: request.url,
				method: request.method,
				authorization: request.headers.get("authorization"),
				terminal: false,
			};
			handlerReceipts.push(receipt);
			try {
				const response = await handleRequest(request);
				response.headers.set("x-ryu-native-peer-call", String(id));
				return response;
			} finally {
				receipt.terminal = true;
				activeHandlers.delete(id);
				changed();
			}
		},
		error(error) {
			peerErrors.push(error instanceof Error ? error.message : String(error));
			return NativeResponse.json(
				{ error: "Owned plugin peer failed" },
				{ status: 500 }
			);
		},
	});
	peerOrigin = server.url.origin;
	globalThis.fetch = observedFetch;
	settleBeforeUnmount = async () => {
		releaseA?.();
		await act(async () => settleNativeTransport());
	};
	dispose = async () => {
		const closureErrors: unknown[] = [];
		let serverStopAcknowledged = false;
		releaseA?.();
		try {
			try {
				await act(async () => settleNativeTransport());
			} catch (error) {
				closureErrors.push(error);
			}
			try {
				await server.stop(closureErrors.length !== 0);
				serverStopAcknowledged = true;
			} catch (error) {
				closureErrors.push(error);
			}
			try {
				await act(async () => settleNativeTransport());
			} catch (error) {
				closureErrors.push(error);
			}
			try {
				// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
				expect(serverStopAcknowledged).toBe(true);
				const consumedIds = bodyReceipts.map((receipt) => receipt.id);
				const cancelledIds: number[] = [];
				for (const cancellation of cancellations) {
					// Before-header rejection has no response ID. Join only one exact remaining
					// terminal physical handler; ambiguous or absent ownership is a failure.
					const candidates = handlerReceipts.filter(
						(handler) =>
							handler.terminal &&
							handler.url === cancellation.url &&
							handler.method === cancellation.method &&
							handler.authorization === cancellation.authorization &&
							!consumedIds.includes(handler.id) &&
							!cancelledIds.includes(handler.id) &&
							(cancellation.id === null || handler.id === cancellation.id)
					);
					// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
					expect(candidates).toHaveLength(1);
					const handler = candidates[0];
					if (!handler) {
						throw new Error(
							"Missing physical native cancellation acknowledgment"
						);
					}
					cancelledIds.push(handler.id);
				}
				// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
				expect([...consumedIds, ...cancelledIds].sort((a, b) => a - b)).toEqual(
					Array.from({ length: nextRequestId }, (_, index) => index + 1)
				);
				// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
				expect(counters()).toEqual({
					activeHandlers: 0,
					nativeExchanges: 0,
					bodyObservations: 0,
					unreadBodies: [],
					queryFetching: 0,
					queryObservers: 0,
				});
				// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
				expect({
					unknownRequests,
					peerErrors,
					transportErrors,
					runtimeErrors,
				}).toEqual({
					unknownRequests: [],
					peerErrors: [],
					transportErrors: [],
					runtimeErrors: [],
				});
			} catch (error) {
				closureErrors.push(error);
			}
		} finally {
			const diagnostics = process.env.RYU_NATIVE_PEER_ARTIFACT_DIR;
			try {
				if (diagnostics) {
					mkdirSync(diagnostics, { recursive: true });
					writeFileSync(
						path.join(diagnostics, `apps-${++fixtureReceiptId}.json`),
						JSON.stringify(
							{
								counters: counters(),
								serverStopAcknowledged,
								requestCount: nextRequestId,
								bodyReceipts,
								handlerReceipts,
								cancellations,
								unknownRequests,
								peerErrors,
								transportErrors,
								runtimeErrors,
								closureErrors: closureErrors.map(String),
							},
							null,
							2
						)
					);
				}
			} finally {
				unsubscribeQuery();
				window.removeEventListener("error", onError);
				window.removeEventListener("unhandledrejection", onUnhandledRejection);
				globalThis.fetch = native.fetch;
				rmSync(directory, { recursive: true, force: true });
			}
		}
		if (closureErrors.length) {
			throw new AggregateError(
				closureErrors,
				"Owned native peer did not close"
			);
		}
	};
	function select(authority: Authority) {
		const node = {
			name: authority,
			url: `${String(server.url).replace(/\/$/, "")}/${authority}`,
			token: `token-${authority}`,
		};
		useNodeStore.setState({
			nodes: [node],
			localNodes: [node],
			cloudNodes: [],
			defaultNode: authority,
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		});
	}
	select("a");
	return {
		settled: settleNativeTransport,
		raw,
		read,
		mutations,
		select,
		holdA() {
			heldA = true;
		},
		held() {
			return Boolean(releaseA);
		},
		release() {
			releaseA?.();
			releaseA = undefined;
		},
		refuseB(value: boolean) {
			refuseB = value;
		},
	};
}

test("a delayed A refusal cannot publish its error into B after B independently acknowledges a toggle", async () => {
	const host = fixture();
	await mount();
	await settle(() => latest.apps[0]?.name === "shared a");
	const first = host.raw("a");
	const originalB = host.read("b");
	host.holdA();
	let retired: ReturnType<typeof latest.toggle> | undefined;
	await act(async () => {
		retired = latest.toggle("shared", false);
	});
	await settle(() => host.held());
	try {
		await act(async () => host.select("b"));
		await settle(() => latest.apps[0]?.name === "shared b");
		await act(async () => {
			expect(await latest.toggle("shared", false)).toEqual({ success: true });
		});
		expect(host.read("b")).toEqual([
			{ ...originalB[0], enabled: false },
			originalB[1],
		]);
		expect(host.raw("a")).toBe(first);
		host.release();
		await act(async () => {
			expect(await retired).toEqual({
				error: "Gateway unreachable (fail-closed): A mutation refused",
				success: false,
			});
		});
		expect(latest.toggleError).toBeNull();
		expect(container?.textContent).not.toContain("A mutation refused");
		expect(latest.apps.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
			{ id: "shared", enabled: false },
			{ id: "unrelated", enabled: true },
		]);
		expect(host.raw("a")).toBe(first);
		expect(host.mutations).toEqual([
			{
				authority: "a",
				method: "POST",
				path: "/api/plugins/shared/disable",
				admitted: false,
			},
			{
				authority: "b",
				method: "POST",
				path: "/api/plugins/shared/disable",
				admitted: true,
			},
		]);
	} finally {
		host.release();
		await act(async () => retired);
	}
});

test("B's own refusal survives a late A error, then explicit B retry and independent reload preserve unrelated records", async () => {
	const host = fixture();
	await mount();
	await settle(() => latest.apps[0]?.name === "shared a");
	const first = host.raw("a");
	const second = host.raw("b");
	host.holdA();
	let retired: ReturnType<typeof latest.toggle> | undefined;
	await act(async () => {
		retired = latest.toggle("shared", false);
	});
	await settle(() => host.held());
	try {
		await act(async () => host.select("b"));
		await settle(() => latest.apps[0]?.name === "shared b");
		host.refuseB(true);
		await act(async () => {
			expect(await latest.toggle("shared", false)).toEqual({
				error: "Gateway unreachable (fail-closed): B mutation refused",
				success: false,
			});
		});
		expect(latest.toggleError).toBe(
			"Gateway unreachable (fail-closed): B mutation refused"
		);
		expect(host.raw("b")).toBe(second);
		expect(latest.apps[0]?.enabled).toBe(true);
		host.release();
		await act(async () => retired);
		expect(latest.toggleError).toBe(
			"Gateway unreachable (fail-closed): B mutation refused"
		);
		expect(container?.textContent).toContain("B mutation refused");
		expect(container?.textContent).not.toContain("A mutation refused");
		await act(async () => latest.clearToggleError());
		expect(latest.toggleError).toBeNull();
		host.refuseB(false);
		await act(async () => {
			expect(await latest.toggle("shared", false)).toEqual({ success: true });
		});
		expect(host.raw("a")).toBe(first);
		expect(host.read("b")[1]).toEqual(JSON.parse(second)[1]);
		await act(async () => host.settled());
		await act(async () => root?.unmount());
		root = undefined;
		container?.remove();
		queryClient.clear();
		await mount();
		await settle(() => latest.apps[0]?.name === "shared b" && !latest.loading);
		expect(latest.apps[0]?.enabled).toBe(false);
		expect(latest.toggleError).toBeNull();
		expect(
			host.mutations.map(({ authority, admitted }) => ({ authority, admitted }))
		).toEqual([
			{ authority: "a", admitted: false },
			{ authority: "b", admitted: false },
			{ authority: "b", admitted: true },
		]);
	} finally {
		host.release();
		await act(async () => retired);
	}
});
