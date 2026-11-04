// apps/desktop/src/lib/api/spaces.test.ts
//
// The Spaces retrieval-mode control, pinned to the Core contract it drives.
//
// This file exists because of a specific failure: a client control and a server
// gate built in the same wave, neither side checking the other, shipping a picker
// that wrote a field nothing read. `CreateSpaceBody` in Core is a plain
// `#[derive(serde::Deserialize)]` with NO `deny_unknown_fields`, so a create body
// carrying `retrievalMode` (camelCase), or `retrieval-mode`, or a mode spelled
// `"graphrag"`, is not a 400 — serde discards the unknown key and Core cheerfully
// creates a vector Space and returns 200. The user picks Graph, sees success, and
// gets a Space that never builds an entity graph. Nothing surfaces, ever.
//
// So the tests below are of two kinds, following `preferences.test.ts` doctrine:
//
//  1. MIRROR tests. Every wire spelling this client sends or reads has its real
//     definition in Rust, in this repo. Each anchor is scoped to a NAMED Rust item
//     and THROWS when that item is gone, so a Core-side rename reads as "this
//     mirror lost its target" rather than as a silently-passing assertion.
//
//  2. BEHAVIOUR tests over the pure functions (`toRetrievalMode`,
//     `describeRetrievalModeChange`). These are about the read path and the copy,
//     where the risk is not drift but a wrong claim shown to the user.
//
// ── The coupling, stated so nobody has to discover it ────────────────────────
//
// The anchors read `apps/core/src/server/mod.rs` and
// `crates/core/spaces/src/lib.rs`, neither of which is owned by whoever owns this
// file. A Core author who renames `set_retrieval_mode` or re-spells a JSON key
// gets a failure in a desktop test they have never opened — which is the point,
// and why each failure names the file, the item, and what to do about it.

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	type RetrievalMode,
	type RetrievalModeProgress,
	setSpaceRetrievalMode,
} from "./spaces.ts";
import {
	ANCHOR_PRESENT,
	completedRetrievalStatus,
	RETRIEVAL_TARGET,
	rustAnchor,
	rustContains,
	rustItemBody,
	SERVER_RS,
	SPACES_RS,
	serverRs,
	spacesRs,
	squeeze,
} from "./spaces-test-anchors.ts";

describe("retrieval-mode wire spellings mirror Core", () => {
	it("uses exactly the two spellings RetrievalMode::as_str emits", () => {
		const asStr = rustItemBody(spacesRs, SPACES_RS, "pub fn as_str(self)");
		// Every `"…"` inside `as_str`, which is the ONE place the column/wire form
		// is defined. A third mode added in Rust fails here until this client and
		// the `RetrievalMode` union learn about it — which is the desired outcome:
		// a mode the UI cannot name is a mode the UI must not silently mis-send.
		const spellings = [...asStr.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
		const clientModes: RetrievalMode[] = ["graph", "vector"];
		expect(spellings).toEqual([...clientModes].sort());
	});

	it("sends the field name Core's create body actually deserializes", () => {
		// `CreateSpaceBody` has no `deny_unknown_fields`, so a mis-spelled key here
		// would be DISCARDED with a 200 rather than rejected — the silent failure
		// this whole file exists to prevent.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"struct CreateSpaceBody",
				"retrieval_mode: Option<String>"
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("reads the mode Core echoes back from the create response", () => {
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn create_space(",
				'"retrieval_mode": mode.as_str()'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("posts to the route Core actually mounts for a mode change", () => {
		// The path built in `setSpaceRetrievalMode`, with the id segment as Core
		// declares it. A route renamed to e.g. `/retrieval_mode` would 404 into the
		// generic error path, which reads as "network problem", not "wrong URL".
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn spaces_routes(",
				'.route("/api/spaces/:id/retrieval-mode", post(set_retrieval_mode))'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("sends the body key the change route requires", () => {
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"struct SetRetrievalModeBody",
				"retrieval_mode: Option<String>"
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("mirrors Core's asynchronous 202 job contract", () => {
		const route = rustItemBody(
			serverRs,
			SERVER_RS,
			"async fn set_retrieval_mode("
		);
		expect(route).toContain("StatusCode::ACCEPTED");
		expect(route).toContain('"job_id"');
		expect(route).toContain('"status"');
		expect(route).toContain('"cancel"');
		const status = rustItemBody(
			serverRs,
			SERVER_RS,
			"async fn retrieval_mode_status("
		);
		expect(status).toContain("retrieval_mode_status");
		const cancel = rustItemBody(
			serverRs,
			SERVER_RS,
			"async fn cancel_retrieval_mode("
		);
		expect(cancel).toContain("cancel_retrieval_mode_rebuild");
	});

	it("pins the final graph copy to one bounded set-based statement", () => {
		const copy = rustItemBody(
			spacesRs,
			SPACES_RS,
			"fn copy_staged_graph_table("
		);
		expect(copy).toContain("INSERT INTO {destination_table}");
		expect(copy).toContain("FROM {source_table} WHERE space_id = ?1");
		expect(copy).not.toContain("rowid >");
		expect(copy).not.toContain("OFFSET");
	});

	it("reads every field the completed status reports", () => {
		// Each of these maps to a field of `RetrievalModeChange` in spaces.ts. A key
		// renamed in Core would arrive as `undefined` and fall through this client's
		// `??` defaults — reporting "0 entities" for a rebuild that mapped hundreds.
		const keys = [
			"change",
			"previous_mode",
			"state",
			"processed_chunks",
			"total_chunks",
		];
		expect(
			keys.map((key) =>
				rustContains(
					spacesRs,
					SPACES_RS,
					"pub struct RetrievalModeJobStatus",
					key
				)
			)
		).toEqual(keys.map(() => ANCHOR_PRESENT));
	});

	it("still receives retrieval_mode on every listed Space", () => {
		// The read path depends on `spaces::Space` serializing the field
		// unconditionally. A `skip_serializing_if` added here would make the
		// Retrieval card show "Vector" for every graph Space.
		const spaceStruct = rustItemBody(spacesRs, SPACES_RS, "pub struct Space {");
		expect(spaceStruct).toContain("pub retrieval_mode: RetrievalMode");
		const modeField = spaceStruct.slice(
			0,
			spaceStruct.indexOf("pub retrieval_mode: RetrievalMode")
		);
		// The attribute, if any, would sit immediately above the field.
		expect(modeField.split("///").at(-1) ?? "").not.toContain(
			"skip_serializing_if"
		);
	});

	it("mirrors Core's LENIENT read-path coercion, not its strict parse", () => {
		// Two different Rust functions with different strictness. `parse` guards
		// WRITES (unknown → 400); `from_str` guards READS off the column (unknown →
		// Vector, so one odd row cannot blank the Spaces list). `toRetrievalMode`
		// is a read-path mapper and must match `from_str`.
		const fromStr = rustItemBody(spacesRs, SPACES_RS, "fn from_str(s: &str)");
		expect(squeeze(fromStr)).toContain('"graph" => Self::Graph');
		expect(squeeze(fromStr)).toContain("_ => Self::Vector");
	});
});

describe("retrieval-mode progress shape", () => {
	it("keeps progress counters separate from the committed mode change", () => {
		const progress: RetrievalModeProgress = {
			jobId: "job",
			state: "running",
			processedChunks: 4,
			totalChunks: 10,
		};
		expect(progress.processedChunks).toBeLessThan(progress.totalChunks);
		expect(progress.state).toBe("running");
	});
});

describe("retrieval-mode job ownership", () => {
	it("cancels a job accepted before the initial response when the signal aborts", async () => {
		const originalFetch = globalThis.fetch;
		const acceptedJobId = "accepted-before-response-job";
		const controller = new AbortController();
		const requests: Array<{ method: string; url: string; body?: string }> = [];

		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				requests.push({
					method,
					url,
					body: z.string().optional().catch(undefined).parse(init?.body),
				});
				if (method === "POST" && url.endsWith("/retrieval-mode")) {
					// Model Core having accepted the job while the response is still in
					// flight. Fetch loses the response if the caller's signal is attached.
					if (init?.signal) {
						return new Promise<Response>((_resolve, reject) => {
							init.signal?.addEventListener(
								"abort",
								() =>
									reject(
										new DOMException("The request was aborted.", "AbortError")
									),
								{ once: true }
							);
							controller.abort();
						});
					}
					controller.abort();
					return Response.json({ job_id: acceptedJobId, space_id: "space" });
				}
				if (method === "POST" && url.endsWith("/retrieval-mode/cancel")) {
					return Response.json({ cancelled: true });
				}
				if (url.includes("/retrieval-mode/status")) {
					return Response.json({
						job_id: acceptedJobId,
						space_id: "space",
						state: "cancelled",
					});
				}
				throw new Error(`unexpected request: ${method} ${url}`);
			},
			{ preconnect: originalFetch.preconnect }
		);

		try {
			await expect(
				setSpaceRetrievalMode(RETRIEVAL_TARGET, "space", "graph", {
					signal: controller.signal,
				})
			).rejects.toMatchObject({ name: "AbortError" });
			expect(
				requests.find(
					({ method, url }) => method === "POST" && url.endsWith("/cancel")
				)?.body
			).toContain(acceptedJobId);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects a status snapshot belonging to another job", async () => {
		const originalFetch = globalThis.fetch;
		const urls: string[] = [];
		const acceptedJobId = "accepted-job";
		let statusCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				urls.push(url);
				if (url.endsWith("/retrieval-mode")) {
					return Response.json({ job_id: acceptedJobId, space_id: "space" });
				}
				if (url.includes("/retrieval-mode/status")) {
					statusCalls += 1;
					return Response.json(
						statusCalls === 1
							? completedRetrievalStatus("other-job")
							: completedRetrievalStatus(acceptedJobId)
					);
				}
				throw new Error(`unexpected request: ${url}`);
			},
			{ preconnect: originalFetch.preconnect }
		);

		try {
			await expect(
				setSpaceRetrievalMode(RETRIEVAL_TARGET, "space", "graph")
			).rejects.toThrow("wrong retrieval-mode job");
			expect(statusCalls).toBe(1);
			expect(new URL(urls[1]).searchParams.get("job_id")).toBe(acceptedJobId);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("removes the polling abort listener after the timer completes", async () => {
		const originalFetch = globalThis.fetch;
		const originalRemoveEventListener =
			AbortSignal.prototype.removeEventListener;
		const controller = new AbortController();
		const removedListeners: EventListener[] = [];
		let statusCalls = 0;
		AbortSignal.prototype.removeEventListener = function (
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | EventListenerOptions
		) {
			const callback = z
				.custom<EventListener>((value) => z.function().safeParse(value).success)
				.safeParse(listener);
			if (type === "abort" && callback.success) {
				removedListeners.push(callback.data);
			}
			return originalRemoveEventListener.call(this, type, listener, options);
		};
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = String(input);
				if (url.endsWith("/retrieval-mode")) {
					return Response.json({
						job_id: "listener-cleanup-job",
						space_id: "space",
					});
				}
				if (url.includes("/retrieval-mode/status")) {
					statusCalls += 1;
					return Response.json(
						statusCalls === 1
							? {
									job_id: "listener-cleanup-job",
									space_id: "space",
									state: "running",
								}
							: completedRetrievalStatus("listener-cleanup-job")
					);
				}
				throw new Error(`unexpected request: ${url}`);
			},
			{ preconnect: originalFetch.preconnect }
		);

		try {
			await setSpaceRetrievalMode(RETRIEVAL_TARGET, "space", "graph", {
				signal: controller.signal,
			});
			expect(removedListeners).toHaveLength(1);
		} finally {
			AbortSignal.prototype.removeEventListener = originalRemoveEventListener;
			globalThis.fetch = originalFetch;
		}
	});

	it("polls to the actual outcome when cancellation is refused", async () => {
		const originalFetch = globalThis.fetch;
		const acceptedJobId = "finalizing-job";
		const controller = new AbortController();
		const requests: Array<{ method: string; url: string; body?: string }> = [];
		let statusCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				requests.push({
					method,
					url,
					body: z.string().optional().catch(undefined).parse(init?.body),
				});
				if (method === "POST" && url.endsWith("/retrieval-mode")) {
					return Response.json({ job_id: acceptedJobId, space_id: "space" });
				}
				if (method === "POST" && url.endsWith("/retrieval-mode/cancel")) {
					return Response.json({ cancelled: false, finalizing: true });
				}
				if (url.includes("/retrieval-mode/status")) {
					statusCalls += 1;
					if (statusCalls === 1) {
						return Response.json({
							job_id: acceptedJobId,
							space_id: "space",
							state: "running",
							processed_chunks: 1,
							total_chunks: 2,
						});
					}
					return Response.json(completedRetrievalStatus(acceptedJobId));
				}
				throw new Error(`unexpected request: ${method} ${url}`);
			},
			{ preconnect: originalFetch.preconnect }
		);

		try {
			const result = await setSpaceRetrievalMode(
				RETRIEVAL_TARGET,
				"space",
				"graph",
				{
					signal: controller.signal,
					onProgress: () => controller.abort(),
				}
			);
			expect(result.note).toBe("done");
			expect(statusCalls).toBe(2);
			expect(requests.at(-1)?.url).toContain("/retrieval-mode/status");
			expect(requests.at(-1)?.body).toBeUndefined();
			expect(
				requests.find(
					({ method, url }) => method === "POST" && url.endsWith("/cancel")
				)?.body
			).toContain(acceptedJobId);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("polls to the terminal cancelled state after cancellation is accepted", async () => {
		const originalFetch = globalThis.fetch;
		const acceptedJobId = "accepted-cancel-job";
		const controller = new AbortController();
		let statusCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (method === "POST" && url.endsWith("/retrieval-mode")) {
					return Response.json({ job_id: acceptedJobId, space_id: "space" });
				}
				if (method === "POST" && url.endsWith("/retrieval-mode/cancel")) {
					return Response.json({ cancelled: true });
				}
				if (url.includes("/retrieval-mode/status")) {
					statusCalls += 1;
					return Response.json({
						job_id: acceptedJobId,
						space_id: "space",
						state: statusCalls === 1 ? "cancelling" : "cancelled",
						processed_chunks: 1,
						total_chunks: 2,
					});
				}
				throw new Error(`unexpected request: ${method} ${url}`);
			},
			{ preconnect: originalFetch.preconnect }
		);

		try {
			await expect(
				setSpaceRetrievalMode(RETRIEVAL_TARGET, "space", "graph", {
					signal: controller.signal,
					onProgress: () => controller.abort(),
				})
			).rejects.toMatchObject({ name: "AbortError" });
			expect(statusCalls).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
