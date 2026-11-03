// The two-authority native shortcut-document peer the
// usePluginShortcutOverrides.http suites drive.
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { act } from "react";
import {
	live,
	NativeRequest,
	NativeResponse,
	nativeClearTimeout,
	nativeFetch,
	nativeResponseJson,
	nativeResponseText,
	nativeSetTimeout,
	selectAuthority,
	shortcutStore,
	validateHeaders,
} from "./usePluginShortcutOverrides.http.test-support.tsx";

export function fixture() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "ryu-shortcut-hook-"));
	live.dispose = async () =>
		rmSync(directory, { recursive: true, force: true });
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
	const { raw, store } = shortcutStore(directory);
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
	live.runtimeErrors = [];
	const onError = (event: ErrorEvent) => live.runtimeErrors.push(event.message);
	const onUnhandledRejection = (event: PromiseRejectionEvent) =>
		live.runtimeErrors.push(String(event.reason));
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onUnhandledRejection);
	const refuseUnknown = (request: Request, problem: string) => {
		unknownRequests.push({ method: request.method, url: request.url, problem });
		return NativeResponse.json({ error: problem }, { status: 400 });
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
				const observeBody = <T>(
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
	live.dispose = async () => {
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
					runtimeErrors: live.runtimeErrors,
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
						path.join(diagnostics, `shortcuts-${++live.fixtureReceiptId}.json`),
						JSON.stringify(
							{
								counters: counters(),
								serverStopAcknowledged,
								requestCount: nextRequestId,
								bodyReceipts,
								unknownRequests,
								peerErrors,
								transportErrors,
								runtimeErrors: live.runtimeErrors,
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
	const select = (authority: "a" | "b") =>
		selectAuthority(String(server.url), authority);
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
