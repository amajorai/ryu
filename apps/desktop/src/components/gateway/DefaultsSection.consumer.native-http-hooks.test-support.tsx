// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
// The per-test hooks of the DefaultsSection.consumer suites.
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	currentNode,
	onError,
	onUnhandledRejection,
	originalNodeState,
	queryClient,
	runtimeErrors,
	setNode,
	TOKEN_KEY,
	unmount,
	until,
	useNodeStore,
} from "./DefaultsSection.consumer.native-http.test-support.tsx";
import {
	previousBackend,
	server,
} from "./DefaultsSection.consumer.native-http-peer.test-support.tsx";
import {
	allowed,
	bodyReadStarts,
	bodyReads,
	calls,
	diagnosticDirectory,
	directory,
	heldBodies,
	heldBodySnapshot,
	live,
	NativeResponse,
	nativeBodyObservations,
	nativeExchanges,
	nativeFetch,
	nativeResponseText,
	ownsDom,
	persistRecords,
	previousActFlag,
	registeredAbortController,
	registeredAbortSignal,
	returnedBodies,
	seed,
	settleNativeTransport,
	transportErrors,
	unexpected,
} from "./DefaultsSection.consumer.native-http-store.test-support.tsx";

/** The per-test setup and teardown every suite on this harness registers. */
export function registerDefaultsSectionConsumerHooks() {
	beforeEach(async () => {
		await unmount();
		await settleNativeTransport();
		queryClient.clear();
		localStorage.clear();
		localStorage.setItem("ryu_client_id", "defaults-proof-client");
		localStorage.setItem("defaults-proof-unrelated", "preserved");
		localStorage.setItem("ryu:timezone", "Asia/Tokyo");
		expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
		live.records = { a: seed("model-a"), foreign: seed("foreign-model") };
		await persistRecords();
		calls.length = 0;
		bodyReads.length = 0;
		bodyReadStarts.length = 0;
		heldBodies.length = 0;
		live.holdLocalReadCredentials = null;
		live.refuseLocalReadCredentials = null;
		unexpected.length = 0;
		transportErrors.length = 0;
		runtimeErrors.length = 0;
		allowed.clear();
		allowed.set("Bearer defaults-a-bearer|defaults-a-jwt", "a");
		allowed.set(
			"Bearer defaults-foreign-bearer|defaults-foreign-jwt",
			"foreign"
		);
		live.refusedLocalWrites = 0;
		live.showEvals = true;
		live.evalGeneration = 0;
		live.showFreshRefusalEvals = false;
		await setNode(currentNode());
	});
	afterEach(async () => {
		try {
			await unmount();
			await settleNativeTransport();
			await until(
				() =>
					live.activeHandlers === 0 &&
					queryClient.isFetching() === 0 &&
					server.pendingRequests === 0 &&
					nativeExchanges.size === 0 &&
					nativeBodyObservations.size === 0 &&
					returnedBodies.size === 0,
				"Actual HTTP/query work outlived renderer teardown"
			);
			await live.persistence;
			expect(server.pendingRequests).toBe(0);
			expect(live.activeHandlers).toBe(0);
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
					join(diagnosticDirectory, `case-${++live.diagnosticCase}.json`),
					JSON.stringify(
						{
							calls,
							bodyReads,
							unexpected,
							runtimeErrors,
							transportErrors,
							activeHandlers: live.activeHandlers,
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
			await live.persistence;
			expect(serverStopAcknowledged).toBe(true);
			expect(server.pendingRequests).toBe(0);
			expect(live.activeHandlers).toBe(0);
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
							activeHandlers: live.activeHandlers,
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
}
