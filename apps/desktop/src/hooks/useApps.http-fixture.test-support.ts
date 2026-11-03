// The two-authority native app-roster peer the useApps.http suites drive.
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { act } from "react";
import {
	type Authority,
	appRecord,
	createTransportLedger,
	isNativeAbort,
	live,
	NativeRequest,
	NativeResponse,
	native,
	nativeResponseJson,
	nativeResponseText,
	queryClient,
	rosterStore,
	selectAuthority,
	validateHeaders,
} from "./useApps.http.test-support.ts";

export function fixture() {
	const directory = mkdtempSync(path.join(os.tmpdir(), "ryu-app-roster-"));
	live.dispose = async () =>
		rmSync(directory, { recursive: true, force: true });
	const record = appRecord;
	const { raw, read, store } = rosterStore(directory);
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
	const {
		activeHandlers,
		handlerReceipts,
		cancellations,
		nativeExchanges,
		bodyObservations,
		unreadBodies,
		bodyReceipts,
		transportErrors,
		changed,
		unsubscribeQuery,
		counters,
		settleNativeTransport,
	} = createTransportLedger();
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
	live.settleBeforeUnmount = async () => {
		releaseA?.();
		await act(async () => settleNativeTransport());
	};
	live.dispose = async () => {
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
						path.join(diagnostics, `apps-${++live.fixtureReceiptId}.json`),
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
								runtimeErrors: live.runtimeErrors,
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
	const select = (authority: Authority) =>
		selectAuthority(String(server.url), authority);
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
