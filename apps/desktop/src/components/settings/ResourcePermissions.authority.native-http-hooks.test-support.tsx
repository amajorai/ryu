// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
// Save, read-back and closure assertions plus the per-test hooks of the
// ResourcePermissions.authority suites.
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { z } from "zod";
import {
	acknowledged,
	assertRenderedRows,
	button,
	completeRead,
	draftInput,
	editor,
	mount,
	node,
	onError,
	onRejection,
	previousNodes,
	publishedReply,
	request,
	selectNode,
	sileo,
	TOKEN_KEY,
	target,
	until,
	useNodeStore,
} from "./ResourcePermissions.authority.native-http.test-support.tsx";
import {
	previousBackend,
	server,
} from "./ResourcePermissions.authority.native-http-peer.test-support.tsx";
import {
	artifacts,
	bodyReads,
	bodyStarts,
	calls,
	clientId,
	credentials,
	directory,
	domAbortController,
	domAbortSignal,
	drain,
	exchanges,
	heldBodies,
	heldSnapshot,
	live,
	NativeResponse,
	nativeFetch,
	nativeResponseText,
	type Overwrite,
	type Owner,
	observations,
	ownsDom,
	previousActFlag,
	publish,
	type Records,
	readPhysical,
	releaseAll,
	resourceId,
	resourcePath,
	runtimeErrors,
	seed,
	transportErrors,
	unexpected,
	unreadIds,
} from "./ResourcePermissions.authority.native-http-store.test-support.tsx";

export async function saveCurrent(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	rows: Overwrite[]
) {
	const start = live.nextId;
	expect(button("Save").disabled).toBe(false);
	await act(async () => button("Save").click());
	await until(
		() =>
			calls.some(
				(call) =>
					call.id > start &&
					call.owner === owner &&
					call.method === "PUT" &&
					acknowledged(call)?.status === 200
			),
		"Actual current Save did not consume its native acknowledgment"
	);
	const write = calls.find(
		(call) => call.id > start && call.owner === owner && call.method === "PUT"
	)!;
	const credential = credentials(owner, variant);
	expect(write).toMatchObject({
		body: { overwrites: rows },
		bearer: `Bearer ${credential.token}`,
		delegation: credential.userJwt,
		status: 200,
	});
	expect(acknowledged(write)?.text).toBe(JSON.stringify({ ok: true }));
	await completeRead(owner, variant, write.id, "Current role");
	await until(
		() =>
			document.body.textContent?.includes("Permissions saved") === true &&
			button("Save").disabled,
		"Real Save consumer did not acknowledge persisted clean state and success Toaster"
	);
	await act(async () => {
		await drain();
	});
	assertRenderedRows(rows);
}
export async function assertForeignRead(expected: Records) {
	const start = live.nextId;
	expect(
		await request(
			target("foreign"),
			resourcePath,
			undefined,
			// Strict, so a read carrying anything beyond the ACL document fails.
			z
				.object({
					id: z.string(),
					kind: z.string(),
					overwrites: z.array(z.unknown()),
				})
				.strict()
		)
	).toEqual({
		kind: "agent",
		id: resourceId,
		overwrites: expected.foreign[resourceId],
	});
	const read = calls.find((call) => call.id > start)!;
	expect(read).toMatchObject({
		owner: "foreign",
		method: "GET",
		body: null,
		bearer: "Bearer permissions-foreign-bearer-a",
		delegation: "permissions-foreign-jwt-a",
		status: 200,
	});
	expect(acknowledged(read)?.text).toBe(
		JSON.stringify({
			kind: "agent",
			id: resourceId,
			overwrites: expected.foreign[resourceId],
		})
	);
	expect(await readPhysical()).toEqual(expected);
}
export async function assertFreshRenderer(
	owner: Owner,
	variant: "a" | "bearer" | "jwt",
	expected: Records
) {
	await unmount();
	const start = live.nextId;
	await selectNode(node(owner, variant));
	await mount();
	await completeRead(owner, variant, start, "Current role");
	expect(editor().querySelectorAll("li")).toHaveLength(2);
	expect(editor().textContent).toContain("Retained team");
	expect(button("Save").disabled).toBe(true);
	assertRenderedRows(expected[owner][resourceId]!);
	expect(await readPhysical()).toEqual(expected);
	await assertForeignRead(expected);
}
export async function assertRetiredConsumer(expected: Records) {
	await unmount();
	const start = live.nextId;
	await selectNode(node("b"));
	await act(async () => {
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "ryu_node_tab_override_enabled",
				newValue: "false",
			})
		);
		// A genuine independently awaited request supplies an HTTP/decoder
		// boundary after the real store/storage events. No guessed quiet delay.
		await assertForeignRead(expected);
		await drain();
	});
	const later = calls.filter((call) => call.id > start);
	expect(later).toHaveLength(1);
	expect(later[0]).toMatchObject({
		owner: "foreign",
		method: "GET",
		url: `${node("foreign").url}${resourcePath}`,
	});
	expect(runtimeErrors).toEqual([]);
}
export function assertRetainedDraft(draft: HTMLInputElement) {
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Unsent permissions draft");
	expect(document.activeElement).toBe(draft);
	expect(localStorage.getItem("permissions-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
}
export async function unmount() {
	// Always release genuine held responses BEFORE awaiting old SDK work. A
	// primary assertion failure must retain its real late receipt, not deadlock
	// teardown or manufacture cancellation/consumption.
	const errors: unknown[] = [];
	try {
		await act(async () => {
			releaseAll();
			await drain();
		});
	} catch (error) {
		errors.push(error);
	}
	try {
		await act(async () => {
			live.root?.unmount();
			await drain();
		});
	} catch (error) {
		errors.push(error);
	}
	live.root = null;
	live.container?.remove();
	live.container = null;
	if (errors.length) {
		throw new AggregateError(
			errors,
			"Real permission renderer teardown failed"
		);
	}
}
export function assertClosure() {
	expect(live.activeHandlers).toBe(0);
	expect(server.pendingRequests).toBe(0);
	expect(exchanges.size).toBe(0);
	expect(observations.size).toBe(0);
	expect([...unreadIds]).toEqual([]);
	expect(unexpected).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expect(transportErrors).toEqual([]);
	expect(
		heldBodies.every((held) => held.released && held.cancelled === null)
	).toBe(true);
	expect(calls.every((call) => call.handlerTerminal && call.status !== 0)).toBe(
		true
	);
	expect(bodyReads.map((body) => body.id).sort((a, b) => a - b)).toEqual(
		calls.map((call) => call.id).sort((a, b) => a - b)
	);
	for (const call of calls) {
		expect(acknowledged(call)).toEqual({
			id: call.id,
			status: call.status,
			text: publishedReply(call),
		});
	}
}
export function diagnostic() {
	return {
		calls,
		bodyStarts,
		bodyReads,
		heldBodies: heldSnapshot(),
		activeHandlers: live.activeHandlers,
		pendingRequests: server.pendingRequests,
		exchanges: exchanges.size,
		bodyObservations: observations.size,
		unreadIds: [...unreadIds],
		unexpected,
		transportErrors,
		runtimeErrors,
	};
}

/** The per-test setup and teardown every suite on this harness registers. */
export function registerResourcePermissionsHooks() {
	beforeEach(async () => {
		await unmount();
		await act(async () => sileo.clear());
		localStorage.clear();
		localStorage.setItem("ryu_client_id", clientId);
		localStorage.setItem("permissions-unrelated", "preserved");
		localStorage.setItem("ryu:timezone", "Asia/Tokyo");
		expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
		await publish(() => seed());
		calls.length = 0;
		bodyReads.length = 0;
		bodyStarts.length = 0;
		heldBodies.length = 0;
		unexpected.length = 0;
		transportErrors.length = 0;
		runtimeErrors.length = 0;
		live.holdPlan = null;
		await selectNode(node("a"));
	});
	afterEach(async () => {
		const errors: unknown[] = [];
		try {
			await unmount();
			assertClosure();
		} catch (error) {
			errors.push(error);
		} finally {
			if (artifacts) {
				try {
					await mkdir(artifacts, { recursive: true });
					await writeFile(
						join(artifacts, `case-${++live.caseNumber}.json`),
						JSON.stringify(
							{
								...diagnostic(),
								cleanupErrors: errors.map(String),
								physical: await readPhysical(),
							},
							null,
							2
						)
					);
				} catch (error) {
					errors.push(error);
				}
			}
		}
		if (errors.length) {
			throw new AggregateError(
				errors,
				"Real permission per-case closure failed"
			);
		}
	});
	afterAll(async () => {
		const errors: unknown[] = [];
		let serverStopAcknowledged = false;
		try {
			await unmount();
			await act(async () => sileo.clear());
		} catch (error) {
			errors.push(error);
		}
		try {
			await server.stop(true);
			serverStopAcknowledged = true;
		} catch (error) {
			errors.push(error);
		}
		try {
			await Promise.allSettled([...exchanges, ...observations]);
			await live.persistence;
			assertClosure();
			expect(serverStopAcknowledged).toBe(true);
		} catch (error) {
			errors.push(error);
		}
		try {
			if (artifacts) {
				await mkdir(artifacts, { recursive: true });
				await writeFile(
					join(artifacts, "closure.json"),
					JSON.stringify(
						{
							...diagnostic(),
							serverStopAcknowledged,
							closureErrors: errors.map(String),
						},
						null,
						2
					)
				);
			}
		} catch (error) {
			errors.push(error);
		}
		try {
			await rm(directory, { recursive: true });
		} catch (error) {
			errors.push(error);
		}
		try {
			useNodeStore.setState(previousNodes);
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onRejection);
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
			if (domAbortController) {
				Object.defineProperty(
					globalThis,
					"AbortController",
					domAbortController
				);
			} else {
				Reflect.deleteProperty(globalThis, "AbortController");
			}
			if (domAbortSignal) {
				Object.defineProperty(globalThis, "AbortSignal", domAbortSignal);
			} else {
				Reflect.deleteProperty(globalThis, "AbortSignal");
			}
			if (ownsDom) {
				await GlobalRegistrator.unregister();
			}
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) {
			throw new AggregateError(errors, "Real permission final closure failed");
		}
	});
}
