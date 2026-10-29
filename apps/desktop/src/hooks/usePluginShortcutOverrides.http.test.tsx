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

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const NativeHeaders = globalThis.Headers;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const nativeResponseText = NativeResponse.prototype.text;
const nativeResponseJson = NativeResponse.prototype.json;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.Response = NativeResponse;
globalThis.Request = NativeRequest;
globalThis.Headers = NativeHeaders;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { usePluginShortcutOverrides } = await import(
	"./usePluginShortcutOverrides.ts"
);
const { useActiveNode } = await import("./useActiveNode.ts");
const { toTarget } = await import("../lib/api/client.ts");
const { useNodeStore } = await import("../store/useNodeStore.ts");
const { CurrentTabIdProvider } = await import("../contexts/TabsContext.tsx");
const { setNodeTabOverride } = await import("./useNodeDisplayMode.ts");
const previousTabOverride = localStorage.getItem(
	"ryu_node_tab_override_enabled"
);
const previousNodes = useNodeStore.getState();
let latest: ReturnType<typeof usePluginShortcutOverrides>;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
let dispose: (() => Promise<void>) | undefined;
let runtimeErrors: string[] = [];
let fixtureReceiptId = 0;
function Consumer() {
	latest = usePluginShortcutOverrides(toTarget(useActiveNode()));
	return createElement(
		"output",
		null,
		JSON.stringify({
			overrides: latest.overrides,
			disabled: latest.disabled,
			error: latest.error,
		})
	);
}
async function mount(tabId?: string) {
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
				"div",
				null,
				tabId === undefined ? (
					createElement(Consumer)
				) : (
					<CurrentTabIdProvider tabId={tabId}>
						<Consumer />
					</CurrentTabIdProvider>
				),
				createElement(Toaster, { theme: "dark" })
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
	throw new Error(
		"Mounted shortcut consumer did not acknowledge the operation"
	);
}
afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	try {
		await act(async () => root?.unmount());
	} catch (error) {
		cleanupErrors.push(error);
	}
	root = undefined;
	container?.remove();
	container = undefined;

	try {
		await dispose?.();
	} catch (error) {
		cleanupErrors.push(error);
	} finally {
		dispose = undefined;
		sileo.clear();
		useNodeStore.setState(previousNodes);
		if (previousTabOverride === null) {
			localStorage.removeItem("ryu_node_tab_override_enabled");
		} else {
			localStorage.setItem(
				"ryu_node_tab_override_enabled",
				previousTabOverride
			);
		}
		window.dispatchEvent(new Event("storage"));
	}
	if (cleanupErrors.length) {
		throw new AggregateError(
			cleanupErrors,
			"Actual mounted consumer cleanup failed"
		);
	}
});
function fixture() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "ryu-shortcut-hook-"));
	dispose = async () => rmSync(directory, { recursive: true, force: true });
	const calls: Array<{
		authority: string;
		method: string;
		admitted: boolean;
		body?: unknown;
	}> = [];
	let refuse = false;
	let hold = false;
	let holdWrite = false;
	let release: (() => void) | undefined;
	const raw = (authority: "a" | "b") =>
		readFileSync(path.join(directory, `${authority}.json`), "utf8");
	const store = (authority: "a" | "b", bytes: string) => {
		const file = path.join(directory, `${authority}.json`);
		writeFileSync(`${file}.new`, bytes);
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
	store(
		"a",
		JSON.stringify({
			"plugin:shared": "Control+Alt+A",
			"chat.new": "Control+N",
			"plugin:other": null,
		})
	);
	store(
		"b",
		JSON.stringify({
			"plugin:shared": "Control+Alt+B",
			"chat.new": "Control+B",
		})
	);
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
	const counters = () => ({
		activeHandlers: activeHandlers.size,
		nativeExchanges: nativeExchanges.size,
		bodyObservations: bodyObservations.size,
		unreadBodies: [...unreadBodies],
	});
	const idle = () =>
		activeHandlers.size === 0 &&
		nativeExchanges.size === 0 &&
		bodyObservations.size === 0 &&
		unreadBodies.size === 0;
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
			if (new URL(request.url).origin !== peerOrigin) {
				refuseUnknown(request, "Unowned native fetch destination");
				throw new Error("Refused unowned native peer destination");
			}
			let exchange: Promise<Response> | undefined;
			try {
				exchange = nativeFetch(request);
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
							transportErrors.push(
								`Native response body ${id}: ${String(error)}`
							);
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
				transportErrors.push(
					`Native exchange ${request.method} ${request.url}: ${String(error)}`
				);
				throw error;
			} finally {
				if (exchange) {
					nativeExchanges.delete(exchange);
				}
				changed();
			}
		},
		{
			preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
				if (new URL(String(args[0])).origin !== peerOrigin) {
					unknownRequests.push({
						method: "PRECONNECT",
						url: String(args[0]),
						problem: "Unowned preconnect",
					});
					throw new Error("Refused unowned native peer preconnect");
				}
				return nativeFetch.preconnect(...args);
			},
		}
	);
	async function handleRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// A tab bound to another computer reads that computer's chat history
		// (its own history provider), with that computer's credential.
		const history = url.pathname.match(/^\/(a|b)\/api\/conversations$/);
		if (
			url.origin === peerOrigin &&
			history &&
			request.method === "GET" &&
			(url.search === "" || url.search === "?preview=1")
		) {
			if (
				request.headers.get("authorization") !== `Bearer token-${history[1]}`
			) {
				return refuseUnknown(
					request,
					"History read without the bound computer's credential"
				);
			}
			return NativeResponse.json({ conversations: [] });
		}
		const match = url.pathname.match(
			/^\/(a|b)\/api\/(preferences\/keybindings|keybindings\/entry)$/
		);
		if (url.origin !== peerOrigin || url.search || !match) {
			return refuseUnknown(
				request,
				"Undeclared preference authority, path or query"
			);
		}
		const isEntryEdit = match[2] === "keybindings/entry";
		if (request.method !== (isEntryEdit ? "POST" : "GET")) {
			return refuseUnknown(request, "Undeclared preference request method");
		}
		const headerProblem = validateHeaders(request);
		if (headerProblem) {
			return refuseUnknown(request, headerProblem);
		}
		const authority = match[1] as "a" | "b";
		const call = {
			authority,
			method: request.method,
			admitted: false,
			body: undefined as unknown,
		};
		calls.push(call);
		// The existing foreign-credential case deliberately sends A's known token to B.
		if (request.headers.get("authorization") !== `Bearer token-${authority}`) {
			return new NativeResponse(null, { status: 401 });
		}
		const bytes = await request.text();
		if (request.method === "GET") {
			if (bytes !== "") {
				return refuseUnknown(request, "Preference reads must have no body");
			}
			const stored = raw(authority);
			if (hold) {
				hold = false;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return NativeResponse.json({ key: "keybindings", value: stored });
		}
		// What Core's `POST /api/keybindings/entry` does: one locked
		// read-modify-write of a single plugin entry, answering the stored document.
		let body: unknown;
		try {
			body = JSON.parse(bytes);
		} catch {
			return refuseUnknown(request, "Entry edit body is not JSON");
		}
		if (
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			!("entry" in body) ||
			typeof body.entry !== "string" ||
			!body.entry.startsWith("plugin:") ||
			Object.keys(body).some(
				(key) => !["entry", "remove", "value"].includes(key)
			)
		) {
			return refuseUnknown(
				request,
				"Entry edits require a plugin entry and only entry, value or remove"
			);
		}
		call.body = body;
		if (holdWrite) {
			holdWrite = false;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}
		if (refuse) {
			return NativeResponse.json(
				{ error: "Refused shortcut write" },
				{ status: 503 }
			);
		}
		let document: unknown;
		try {
			document = JSON.parse(raw(authority));
		} catch {
			document = null;
		}
		if (!document || typeof document !== "object" || Array.isArray(document)) {
			return NativeResponse.json(
				{ error: "the stored keybindings document is not a JSON object" },
				{ status: 500 }
			);
		}
		const next: Record<string, unknown> = { ...document };
		if ("remove" in body && body.remove === true) {
			delete next[body.entry];
		} else {
			next[body.entry] = "value" in body ? body.value : null;
		}
		const stored = JSON.stringify(next);
		store(authority, stored);
		call.admitted = true;
		return NativeResponse.json({ value: stored });
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const id = ++nextRequestId;
			activeHandlers.add(id);
			try {
				const response = await handleRequest(request);
				response.headers.set("x-ryu-native-peer-call", String(id));
				return response;
			} finally {
				activeHandlers.delete(id);
				changed();
			}
		},
		error(error) {
			peerErrors.push(error instanceof Error ? error.message : String(error));
			return NativeResponse.json(
				{ error: "Owned preference peer failed" },
				{ status: 500 }
			);
		},
	});
	peerOrigin = server.url.origin;
	globalThis.fetch = observedFetch;
	dispose = async () => {
		const closureErrors: unknown[] = [];
		let serverStopAcknowledged = false;
		release?.();
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
				// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
				expect(
					bodyReceipts.map((receipt) => receipt.id).sort((a, b) => a - b)
				).toEqual(
					Array.from({ length: nextRequestId }, (_, index) => index + 1)
				);
				// biome-ignore lint/suspicious/noMisplacedAssertion: dispose runs only from this file's afterEach, so each real case fails on unretired native peer resources.
				expect(counters()).toEqual({
					activeHandlers: 0,
					nativeExchanges: 0,
					bodyObservations: 0,
					unreadBodies: [],
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
						path.join(diagnostics, `shortcuts-${++fixtureReceiptId}.json`),
						JSON.stringify(
							{
								counters: counters(),
								serverStopAcknowledged,
								requestCount: nextRequestId,
								bodyReceipts,
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
				window.removeEventListener("error", onError);
				window.removeEventListener("unhandledrejection", onUnhandledRejection);
				globalThis.fetch = nativeFetch;
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
	const select = (authority: "a" | "b") => {
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
	};
	select("a");
	return {
		settled: settleNativeTransport,
		calls,
		raw,
		store,
		select,
		refuse: (value: boolean) => {
			refuse = value;
		},
		hold: () => {
			hold = true;
		},
		holdWrite: () => {
			holdWrite = true;
		},
		held: () => Boolean(release),
		release: () => {
			release?.();
			release = undefined;
		},
	};
}

test("mounted node shortcut writes and resets preserve disk records, surface refusals and survive independent remount", async () => {
	const host = fixture();
	await mount();
	await settle(() => !latest.disabled);
	const original = host.raw("a");
	const foreign = host.raw("b");
	host.refuse(true);
	await act(async () => latest.save("shared", "Control+Alt+R"));
	expect(container?.textContent).toContain("Couldn't update plugin shortcut");
	expect(container?.querySelector("output")?.textContent).toContain(
		"Control+Alt+A"
	);
	expect(host.raw("a")).toBe(original);
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+A");
	host.refuse(false);
	await act(async () => latest.save("shared", "Control+Alt+R"));
	expect(JSON.parse(host.raw("a"))).toEqual({
		"plugin:shared": "Control+Alt+R",
		"chat.new": "Control+N",
		"plugin:other": null,
	});
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+R");
	expect(host.raw("b")).toBe(foreign);
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	await mount();
	await settle(() => !latest.disabled);
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+R");
	host.refuse(true);
	await act(async () => latest.save("shared", undefined));
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+R");
	host.refuse(false);
	await act(async () => latest.save("shared", undefined));
	expect(JSON.parse(host.raw("a"))).toEqual({
		"chat.new": "Control+N",
		"plugin:other": null,
	});
	expect(host.raw("b")).toBe(foreign);
	expect(
		host.calls.filter((c) => c.method === "POST").map((c) => c.admitted)
	).toEqual([false, true, false, true]);
});

test("malformed initial and externally corrupted native shortcut documents refuse writes and recover explicitly", async () => {
	const host = fixture();
	host.store("a", '{"plugin:shared":42}');
	await mount();
	await settle(() => latest.error);
	expect(latest.disabled).toBe(true);
	await act(async () => latest.save("shared", "Control+R"));
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	host.store("a", '{"plugin:shared":"Control+A","chat.new":"Control+N"}');
	await act(async () => latest.retry());
	expect(latest.disabled).toBe(false);
	host.store("a", "{broken");
	await act(async () => latest.save("shared", "Control+R"));
	// Core refuses to edit a document that is not a JSON object, and says so.
	expect(host.raw("a")).toBe("{broken");
	expect(latest.overrides["plugin:shared"]).toBe("Control+A");
	expect(container?.textContent).toContain("Couldn't update plugin shortcut");
	expect(host.calls.filter((c) => c.method === "POST")).toMatchObject([
		{ authority: "a", admitted: false },
	]);
});

test("a write whose node changed in flight lands on the node it was sent to and never repaints the editor, and unmount retires a held initial read", async () => {
	const host = fixture();
	await mount();
	await settle(() => !latest.disabled);
	host.holdWrite();
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = latest.save("shared", "Control+R");
	});
	await settle(() => host.held());
	await act(async () => {
		host.select("b");
		host.select("a");
	});
	host.release();
	await act(async () => pending);
	// The request had already gone to node A, so Core applied it there; the
	// editor, which moved on, does not show that result.
	expect(host.calls.filter((c) => c.method === "POST")).toMatchObject([
		{ authority: "a", admitted: true },
	]);
	expect(JSON.parse(host.raw("a"))["plugin:shared"]).toBe("Control+R");
	expect(latest.overrides["plugin:shared"]).not.toBe("Control+R");
	await act(async () => latest.retry());
	await settle(() => !latest.disabled);
	expect(latest.overrides["plugin:shared"]).toBe("Control+R");
	await act(async () => latest.save("shared", "Control+C"));
	expect(JSON.parse(host.raw("a"))["plugin:shared"]).toBe("Control+C");
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	host.hold();
	await mount();
	await settle(() => host.held());
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	host.select("b");
	host.release();
	await act(async () => host.settled());
	await mount();
	await settle(() => !latest.disabled);
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+B");
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(2);
});

test("foreign node credentials disable the mounted editor until the selected node reloads with current authority", async () => {
	const host = fixture();
	host.select("b");
	const current = useNodeStore.getState().nodes[0];
	if (!current) {
		throw new Error("Expected the selected fixture node");
	}
	const foreign = { ...current, token: "token-a" };
	useNodeStore.setState({ nodes: [foreign], localNodes: [foreign] });
	const first = host.raw("a");
	const second = host.raw("b");
	await mount();
	await settle(() => latest.error);
	expect(latest.disabled).toBe(true);
	await act(async () => latest.save("shared", "Control+Z"));
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	expect(host.raw("a")).toBe(first);
	expect(host.raw("b")).toBe(second);
	await act(async () => host.select("b"));
	await settle(() => !latest.disabled);
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+B");
	await act(async () => latest.save("shared", "Control+Y"));
	expect(host.raw("a")).toBe(first);
	expect(JSON.parse(host.raw("b"))).toEqual({
		"plugin:shared": "Control+Y",
		"chat.new": "Control+B",
	});
	expect(host.calls.filter((c) => c.method === "POST")).toMatchObject([
		{ authority: "b", admitted: true },
	]);
});

test("a newer same-node reload remains authoritative after an older acknowledged read completes", async () => {
	const host = fixture();
	await mount();
	await settle(() => !latest.disabled);
	host.hold();
	let retired: Promise<void> | undefined;
	await act(async () => {
		retired = latest.retry();
	});
	await settle(() => host.held());
	const fresh = {
		"plugin:shared": "Control+Fresh",
		"chat.new": "Control+N",
		"plugin:other": null,
	};
	host.store("a", JSON.stringify(fresh));
	await act(async () => latest.retry());
	expect(latest.overrides).toEqual(fresh);
	expect(latest.disabled).toBe(false);
	host.release();
	await act(async () => retired);
	expect(latest.overrides).toEqual(fresh);
	expect(latest.disabled).toBe(false);
	expect(container?.querySelector("output")?.textContent).toContain(
		"Control+Fresh"
	);
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	expect(JSON.parse(host.raw("a"))).toEqual(fresh);
});

test("changing per-tab node resolution does not retire its acknowledged load on an unrelated store notification", async () => {
	const host = fixture();
	const first = useNodeStore.getState().nodes[0];
	if (!first) {
		throw new Error("Expected fixture node A");
	}
	const second = {
		...first,
		name: "b",
		url: first.url.replace(/\/a$/, "/b"),
		token: "token-b",
	};
	useNodeStore.setState({
		nodes: [first, second],
		localNodes: [first, second],
		tabOverrides: { "plugin-test-tab": "b" },
	});
	setNodeTabOverride(true);
	await mount("plugin-test-tab");
	await settle(() => !latest.disabled);
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+B");
	const unrelated = host.raw("b");
	host.hold();
	await act(async () => setNodeTabOverride(false));
	await settle(() => host.held());
	await act(async () => useNodeStore.setState({ autoSelect: false }));
	host.release();
	await settle(() => !latest.disabled);
	expect(latest.overrides["plugin:shared"]).toBe("Control+Alt+A");
	await act(async () => latest.save("shared", "Control+Resolved"));
	expect(JSON.parse(host.raw("a"))).toEqual({
		"plugin:shared": "Control+Resolved",
		"chat.new": "Control+N",
		"plugin:other": null,
	});
	expect(host.raw("b")).toBe(unrelated);
	expect(host.calls.filter((call) => call.method === "POST")).toMatchObject([
		{ authority: "a", admitted: true },
	]);
});

test("an acknowledged B editor can save independently while a retired A write remains held", async () => {
	const host = fixture();
	await mount();
	await settle(() => !latest.disabled);
	const first = host.raw("a");
	host.holdWrite();
	let retired: Promise<void> | undefined;
	await act(async () => {
		retired = latest.save("shared", "Control+Retired");
	});
	await settle(() => host.held());
	try {
		await act(async () => host.select("b"));
		await settle(() => latest.overrides["plugin:shared"] === "Control+Alt+B");
		expect(latest.disabled).toBe(false);
		await act(async () => latest.save("shared", "Control+Independent"));
		expect(JSON.parse(host.raw("b"))).toEqual({
			"plugin:shared": "Control+Independent",
			"chat.new": "Control+B",
		});
		expect(host.raw("a")).toBe(first);
		expect(host.calls.filter((call) => call.method === "POST")).toMatchObject([
			{ authority: "a", admitted: false },
			{ authority: "b", admitted: true },
		]);
	} finally {
		host.release();
		await act(async () => retired);
	}
	// The held write was already addressed to A, which applies it on release;
	// the B editor neither shows it nor loses its own result.
	expect(JSON.parse(host.raw("a"))["plugin:shared"]).toBe("Control+Retired");
	expect(latest.overrides["plugin:shared"]).toBe("Control+Independent");
	expect(latest.disabled).toBe(false);
});
